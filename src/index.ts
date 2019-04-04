
import { Logger } from '@viva-eng/logger';
import { createPool, PoolConfig, PoolConnection, Pool, MysqlError } from 'mysql';
import { SelectQueryResult, WriteQueryResult, QueryResult, Query, StreamingSelectCallback, SelectQuery, WriteQuery } from './query';
import { formatDuration } from './format-duration';

export { SelectQueryResult, WriteQueryResult, QueryResult, Query, StreamingSelectCallback, SelectQuery, WriteQuery } from './query';

type Role = 'master' | 'replica';

export const enum TransactionType {
	ReadOnly = 'read only',
	ReadWrite = 'read write'
}

export interface ClusterConfig {
	master: PoolConfig,
	replica: PoolConfig,
	logger: Logger
}

export interface HealthcheckResult {
	available: boolean,
	url: string,
	timeToConnection?: string,
	duration?: string,
	warning?: string,
	info?: string
}

export interface HealthcheckResults {
	master: HealthcheckResult,
	replica: HealthcheckResult
}

const holdTimers: WeakMap<PoolConnection, NodeJS.Timeout> = new WeakMap();
const connectionRoles: WeakMap<PoolConnection, Role> = new WeakMap();
const connectionPools: WeakMap<PoolConnection, DatabasePool> = new WeakMap();
const transactions: WeakMap<PoolConnection, TransactionType> = new WeakMap();

export class DatabasePool {
	protected readonly master: Pool;
	protected readonly replica: Pool;
	protected readonly logger: Logger;
	public readonly masterUrl: string;
	public readonly replicaUrl: string;

	constructor(protected readonly config: ClusterConfig) {
		this.logger = config.logger;
		this.master = makePool('master', config.master, config.logger, this);
		this.replica = makePool('replica', config.replica, config.logger, this);
		this.masterUrl = `mysql://${config.master.host}:${config.master.port}/${config.master.database}`;
		this.replicaUrl = `mysql://${config.master.host}:${config.master.port}/${config.master.database}`;
	}

	getReadConnection() : Promise<PoolConnection> {
		return new Promise((resolve, reject) => {
			this.replica.getConnection((error, connection) => {
				if (error) {
					return reject(error);
				}

				resolve(connection);
			});
		});
	}

	getWriteConnection() : Promise<PoolConnection> {
		return new Promise((resolve, reject) => {
			this.master.getConnection((error, connection) => {
				if (error) {
					return reject(error);
				}

				resolve(connection);
			});
		});
	}

	/**
	 * Execute a query against the database
	 *
	 * @param query The query to run
	 * @param params Any parameters to pass into the query
	 * @typeparam P The type of parameters the query takes
	 * @typeparam Q The type of query being executed
	 * @typeparam R The type of record returned as a result (if running a select query)
	 */
	async query<P, R extends QueryResult>(query: Query<P, R>, params?: P) : Promise<R> {
		const isSelect = query instanceof SelectQuery;
		const connection = isSelect
			? await this.getReadConnection()
			: await this.getWriteConnection();

		const result = await this.runQuery(connection, query, params) as R;

		connection.release();

		return result;
	}

	runQuery<P, R extends QueryResult>(connection: PoolConnection, query: Query<P, R>, params?: P, retries?: number) : Promise<R> {
		const startTime = process.hrtime();
		const isSelect = query instanceof SelectQuery;
		const role = connectionRoles.get(connection);

		this.logger.debug('Starting MySQL Query', {
			threadId: connection.threadId,
			dbRole: role,
			query: query.template
		});

		return new Promise(async (resolve, reject) => {
			const compiledQuery = query.compile(params);

			const retry = (retries: number) => {
				const backoff = (4 - retries) ** 2 * 500;

				setTimeout(() => {
					// @ts-ignore The fourth `retries` param is intentionally hidden, ignore the warning
					this.runQuery(connection, query, params, retries - 1).then(resolve, reject);
				}, backoff);
			};

			const onError = (error: MysqlError) => {
				const duration = formatDuration(process.hrtime(startTime));

				if (error.fatal) {
					this.logger.warn('MySQL Query Error', {
						threadId: connection.threadId,
						dbRole: role,
						code: error.code,
						fatal: error.fatal,
						error: error.sqlMessage,
						query: query.template,
						duration
					});

					onRelease(this.logger)(connection);
					connection.destroy();

					return reject(error);
				}

				const remainingRetries = retries == null ? 3 : retries;

				if (query.isRetryable(error)) {
					this.logger.warn('MySQL Query Error', {
						threadId: connection.threadId,
						dbRole: role,
						code: error.code,
						fatal: error.fatal,
						error: error.sqlMessage,
						query: query.template,
						duration,
						retryable: true,
						retriesRemaining: remainingRetries
					});

					if (remainingRetries) {
						return retry(remainingRetries);
					}

					return reject(error);
				}

				this.logger.warn('MySQL Query Error', {
					threadId: connection.threadId,
					dbRole: role,
					code: error.code,
					fatal: error.fatal,
					error: error.sqlMessage,
					query: query.template,
					duration,
					retryable: false
				});

				reject(error);
			};

			connection.query(compiledQuery, (error, results, fields) => {
				if (error) {
					return onError(error);
				}

				const duration = formatDuration(process.hrtime(startTime));

				this.logger.verbose('MySQL Query Complete', {
					threadId: connection.threadId,
					dbRole: role,
					duration,
					query: query.template
				});

				if (isSelect) {
					const result: SelectQueryResult<any> = {
						results,
						fields
					};

					query;

					return resolve(result as R);
				}

				return resolve(results);
			});
		});
	}

	healthcheck() : Promise<HealthcheckResults> {
		return new Promise(async (resolve, reject) => {
			resolve({
				master: await healthcheck(this.logger, this.masterUrl, this.master),
				replica: await healthcheck(this.logger, this.replicaUrl, this.replica)
			});
		});
	}

	destroy() : Promise<void[]> {
		return Promise.all([
			closePool(this.master),
			closePool(this.replica)
		]);
	}

	async startTransaction(transactionType: TransactionType = TransactionType.ReadOnly) : Promise<PoolConnection> {
		const connection = transactionType === TransactionType.ReadOnly
			? await this.getReadConnection()
			: await this.getWriteConnection();

		const query = transactionType === TransactionType.ReadOnly
			? 'start transaction read only'
			: 'start transaction read write';

		const role = connectionRoles.get(connection);

		transactions.set(connection, transactionType);

		this.logger.debug('Starting new MySQL transaction', {
			threadId: connection.threadId,
			dbRole: role,
			transactionType
		});

		return new Promise((resolve, reject) => {
			connection.query(query, (error) => {
				if (error) {
					this.logger.error('Failed to start MySQL transaction', {
						threadId: connection.threadId,
						dbRole: role,
						transactionType,
						error
					});

					return reject(error);
				}

				resolve(connection);
			});
		});
	}

	commitTransaction(connection: PoolConnection) : Promise<void> {
		const role = connectionRoles.get(connection);
		const transactionType = transactions.get(connection);

		return new Promise((resolve, reject) => {
			if (transactionType == null) {
				this.logger.error('Attempted to commit a transaction when none was running', {
					threadId: connection.threadId,
					dbRole: role
				});

				return reject(new Error('Cannot commit transaction; none is running'));
			}

			this.logger.debug('Commiting MySQL transaction', {
				threadId: connection.threadId,
				dbRole: role,
				transactionType
			});

			connection.query('commit', (error) => {
				if (error) {
					this.logger.warn('Failed to commit transaction', {
						threadId: connection.threadId,
						dbRole: role,
						error
					});

					return reject(error);
				}

				this.logger.debug('Commit successful', {
					threadId: connection.threadId,
					dbRole: role,
					transactionType
				});

				transactions.delete(connection);
				resolve();
			});
		});
	}

	rollbackTransaction(connection: PoolConnection) : Promise<void> {
		const role = connectionRoles.get(connection);
		const transactionType = transactions.get(connection);

		return new Promise((resolve, reject) => {
			if (transactionType == null) {
				this.logger.error('Attempted to rollback a transaction when none was running', {
					threadId: connection.threadId,
					dbRole: role
				});

				return reject(new Error('Cannot rollback transaction; none is running'));
			}

			this.logger.debug('Rolling back MySQL transaction', {
				threadId: connection.threadId,
				dbRole: role,
				transactionType
			});

			connection.query('rollback', (error) => {
				if (error) {
					this.logger.warn('Failed to rollback transaction', {
						threadId: connection.threadId,
						dbRole: role,
						error
					});

					return reject(error);
				}

				this.logger.debug('Rollback successful', {
					threadId: connection.threadId,
					dbRole: role,
					transactionType
				});

				transactions.delete(connection);
				resolve();
			});
		});
	}
}

const makePool = (role: Role, config: PoolConfig, logger: Logger, dbPool: DatabasePool) : Pool => {
	const pool = createPool(config);

	pool.on('connection', onConnection(role, logger, dbPool));
	pool.on('acquire', onAcquire(logger));
	pool.on('release', onRelease(logger));
	pool.on('enqueue', () => {
		logger.warn('No remaining connections available in the database pool, queue up query');
	});

	return pool;
};

const closePool = (pool: Pool) : Promise<void> => {
	return new Promise((resolve, reject) => {
		pool.end((error) => {
			if (error) {
				return reject(error);
			}

			resolve();
		});
	});
};

const onConnection = (role: Role, logger: Logger, dbPool: DatabasePool) => (connection: PoolConnection) => {
	connectionRoles.set(connection, role);
	connectionPools.set(connection, dbPool);

	logger.silly('New MySQL connection established', { threadId: connection.threadId, dbRole: role });

	connection.on('error', (error) => {
		logger.error('Unhandled MySQL Error', {
			threadId: connection.threadId,
			dbRole: role,
			code: error.code,
			fatal: error.fatal,
			error: error.sqlMessage
		});

		if (error.fatal) {
			onRelease(logger)(connection);
			connection.destroy();
		}
	});
};

const onAcquire = (logger: Logger) => (connection: PoolConnection) => {
	const role = connectionRoles.get(connection);
	const onHeldTooLong = () => {
		logger.warn('MySQL connection held for over a minute', { threadId: connection.threadId, dbRole: role });
	};

	holdTimers.set(connection, setTimeout(onHeldTooLong, 60000));
};

const onRelease = (logger: Logger) => (connection: PoolConnection) => {
	const role = connectionRoles.get(connection);
	const pool = connectionPools.get(connection);
	const transactionType = transactions.get(connection);

	if (transactionType != null) {
		logger.error('A connection was released that still had an open transaction; Forcing rollback', {
			threadId: connection.threadId,
			dbRole: role,
			transactionType
		});

		pool.rollbackTransaction(connection);
	}

	logger.silly('MySQL connection released', { threadId: connection.threadId, dbRole: role });

	const timer = holdTimers.get(connection);

	if (timer) {
		clearTimeout(timer);
		holdTimers.delete(connection);
	}
};

const healthcheck = async (logger: Logger, url: string, pool: Pool) : Promise<HealthcheckResult> => {
	try {
		const result = await testPool(logger, url, pool);
		const status: HealthcheckResult = {
			url,
			available: true,
			timeToConnection: formatDuration(result.timeToConnection),
			duration: formatDuration(result.duration)
		};

		if (result.duration[0] > 0 || result.duration[1] / 10e5 > 50) {
			status.warning = 'Connection slower than 50ms';
		}

		return status;
	}

	catch (error) {
		return {
			url,
			available: false,
			info: error.code
		};
	}
};

interface TestResult {
	timeToConnection: [ number, number ],
	duration: [ number, number ]
}

const testPool = (logger:Logger, url: string, pool: Pool) : Promise<TestResult> => {
	return new Promise((resolve, reject) => {
		const startTime = process.hrtime();

		pool.getConnection((error, connection) => {
			const timeToConnection = process.hrtime(startTime);

			if (error) {
				return reject(error);
			}
			
			const role = connectionRoles.get(connection);

			connection.query('select version() as version', (error) => {
				const duration = process.hrtime(startTime);

				logger.verbose('MySQL Healthcheck Complete', {
					threadId: connection.threadId,
					dbRole: role,
					duration: formatDuration(duration)
				});

				connection.release();

				if (error) {
					return reject(error);
				}

				resolve({
					timeToConnection: timeToConnection,
					duration: duration
				});
			});
		});
	});
};

