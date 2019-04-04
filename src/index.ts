
import { Logger } from '@viva-eng/logger';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';
import { request as httpsRequest } from 'https';
import { HttpTimer } from './timer';
import { configureDnsCache, DnsCacheParams } from './dns-cache';
import { TimeoutAbort, NetworkError, IsRetryableCallback, retryNetworkErrors } from './retryable';

export { DnsCacheParams } from './dns-cache';
export { TimeoutAbort, NetworkError, IsRetryableCallback, retryNetworkErrors } from './retryable';

let nextRequestId: number = 1;

export interface HttpClientParams {
	hostname: string;
	port: number;
	ssl: boolean;
	logger: Logger;
	timeout?: number;
	retries?: number;
	isRetryable?: IsRetryableCallback;
	options?: any;
}

export interface HttpRequestOptions {
	body?: string | Buffer;
	headers?: {
		[header: string]: string;
	};
	timeout?: number;
	retries?: number;
	/** Internal property, used for managing retry attempts */
	attempt?: number;
	isRetryable?: IsRetryableCallback;
	options?: any;
}

export class HttpClient {
	public readonly hostname: string;
	public readonly port: number;
	public readonly ssl: boolean;
	public readonly logger: Logger;
	public readonly timeout: number;
	public readonly retries: number;
	public readonly isRetryable: IsRetryableCallback;
	public readonly options?: any;

	static configureDnsCache(params: DnsCacheParams) : void {
		configureDnsCache(params);
	}

	constructor(params: HttpClientParams) {
		this.hostname = params.hostname;
		this.port = params.port;
		this.ssl = params.ssl;
		this.logger = params.logger;
		this.timeout = params.timeout || 0;
		this.retries = params.retries || 0;
		this.isRetryable = params.isRetryable || retryNetworkErrors;
		this.options = params.options;
	}

	toString() {
		return `#<HttpClient host=${this.hostname} port=${this.port} ssl=${this.ssl}>`;
	}

	request(method: string, path: string, params: HttpRequestOptions) : Promise<IncomingMessage> {
		const requestId = nextRequestId++;

		if (requestId >= Number.MAX_SAFE_INTEGER) {
			nextRequestId = 1;
		}

		const timeout = params.timeout == null ? this.timeout : params.timeout;
		const isRetryable = params.isRetryable == null ? this.isRetryable : params.isRetryable;
		const options: RequestOptions = {
			hostname: this.hostname,
			port: this.port,
			method: method
		};

		if (this.options) {
			Object.assign(options, this.options);
		}

		if (params.options) {
			Object.assign(options, params.options);
		}

		return new Promise((resolve, reject) => {
			this.logger.verbose('Starting outgoing HTTP request', {
				requestId,
				hostname: this.hostname,
				port: this.port,
				ssl: this.ssl,
				method: options.method,
				path: options.path,
				timeout: timeout
			});

			const retryIfPossible = (outcome: IncomingMessage | NetworkError | Symbol) => {
				const attempt = params.attempt || 0;
				const retries = params.retries == null ? this.retries : params.retries;
	
				if (retries) {
					if (isRetryable(outcome, options)) {
						const newParams = Object.assign({ }, params);

						newParams.retries = retries - 1;
						newParams.attempt = attempt + 1;

						const backoff = (2 ** attempt) * 250;
						const doRetry = () => {
							this.request(method, path, newParams).then(resolve, reject);
						};

						setTimeout(doRetry, backoff);

						return;
					}
				}

				const durations = timer.durations();

				this.logger.verbose('Outbound HTTP request failed', {
					requestId,
					hostname: this.hostname,
					port: this.port,
					ssl: this.ssl,
					method: options.method,
					path: options.path,
					...durations
				});

				reject(outcome);
			};

			const onResponse = (res: IncomingMessage) => {
				timer.onResponse(res);

				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					const contentLength = Buffer.byteLength(data, 'utf8');
					const durations = timer.durations();

					this.logger.verbose('Outbound HTTP request complete', {
						requestId,
						hostname: this.hostname,
						port: this.port,
						method: options.method,
						path: options.path,
						status: res.statusCode,
						contentLength,
						...durations
					});

					if (res.statusCode >= 400) {
						retryIfPossible(res);
					}

					else {
						resolve(res);
					}
				});
			};

			const req = this.ssl
				? httpsRequest(options, onResponse)
				: httpRequest(options, onResponse);

			const timer = new HttpTimer(req, requestId);

			let aborted = false;

			req.on('error', (error) => {
				if (aborted) {
					return;
				}

				this.logger.warn('An error occured while trying to make an HTTP request', { requestId, error });

				retryIfPossible(error as NetworkError);
			});

			if (timeout) {
				req.setTimeout(timeout, () => {
					this.logger.warn('HTTP request timed out', { requestId, timeout });

					aborted = true;
					req.abort();

					retryIfPossible(TimeoutAbort);
				});
			}

			if (params.body && method !== 'GET' && method !== 'HEAD') {
				req.write(params.body);
			}

			req.end();
		});
	}
}
