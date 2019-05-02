
import { Logger } from '@viva-eng/logger';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';
import { request as httpsRequest } from 'https';
import { HttpTimer, TimerResult } from './timer';
import { configureDnsCache, DnsCacheParams } from './dns-cache';
import { TimeoutAbort, NetworkError, IsRetryableCallback, retryNetworkErrors } from './retryable';

export { DnsCacheParams } from './dns-cache';
export { TimeoutAbort, NetworkError, IsRetryableCallback, retryNetworkErrors } from './retryable';

let nextRequestId: number = 1;

interface Headers {
	[header: string]: string;
}

export interface HttpClientParams {
	hostname: string;
	port: number;
	ssl: boolean;
	headers?: Headers;
	logger: Logger;
	timeout?: number;
	retries?: number;
	isRetryable?: IsRetryableCallback;
	slowThreshold?: number;
	options?: any;
}

export interface HttpRequestOptions {
	body?: string | Buffer;
	headers?: Headers;
	timeout?: number;
	retries?: number;
	isRetryable?: IsRetryableCallback;
	slowThreshold?: number;
	options?: any;
}

export interface Response extends IncomingMessage {
	body?: string;
	timing?: TimerResult;
	json?: any
}

export class HttpClient {
	public readonly hostname: string;
	public readonly port: number;
	public readonly headers?: Headers;
	public readonly ssl: boolean;
	public readonly logger: Logger;
	public readonly timeout: number;
	public readonly retries: number;
	public readonly isRetryable: IsRetryableCallback;
	public readonly slowThreshold: number;
	public readonly options?: any;

	static configureDnsCache(params: DnsCacheParams) : void {
		configureDnsCache(params);
	}

	constructor(params: HttpClientParams) {
		this.hostname = params.hostname;
		this.port = params.port;
		this.ssl = params.ssl;
		this.headers = params.headers || { };
		this.logger = params.logger;
		this.timeout = params.timeout || 0;
		this.retries = params.retries || 0;
		this.isRetryable = params.isRetryable || retryNetworkErrors;
		this.slowThreshold = params.slowThreshold || 200;
		this.options = params.options;
	}

	toString() {
		return `#<HttpClient host=${this.hostname} port=${this.port} ssl=${this.ssl}>`;
	}

	request(method: string, path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest(method, path, params);
	}

	get(path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest('GET', path, params);
	}

	post(path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest('POST', path, params);
	}

	put(path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest('PUT', path, params);
	}

	patch(path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest('PATCH', path, params);
	}

	delete(path: string, params: HttpRequestOptions) : Promise<Response> {
		return this._makeRequest('DELETE', path, params);
	}

	protected _makeRequest(method: string, path: string, params: HttpRequestOptions, attempt: number = 1) : Promise<Response> {
		const requestId = nextRequestId++;

		if (requestId >= Number.MAX_SAFE_INTEGER) {
			nextRequestId = 1;
		}

		const timeout = params.timeout == null ? this.timeout : params.timeout;
		const isRetryable = params.isRetryable == null ? this.isRetryable : params.isRetryable;
		const options: RequestOptions = {
			hostname: this.hostname,
			port: this.port,
			method: method,
			path: path,
			headers: {
				...this.headers,
				...(params.headers || { })
			}
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

			const retryIfPossible = (outcome: Response | NetworkError | Symbol) => {
				const retries = params.retries == null ? this.retries : params.retries;
	
				if (retries) {
					if (isRetryable(outcome, options)) {
						const newParams = Object.assign({ }, params);

						newParams.retries = retries - 1;

						const backoff = (2 ** attempt) * 250;
						const doRetry = () => {
							this._makeRequest(method, path, newParams, attempt + 1).then(resolve, reject);
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

			const onResponse = (res: Response) => {
				timer.onResponse(res);

				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					const contentLength = Buffer.byteLength(data, 'utf8');
					const durations = timer.durations();
					const logLevel = durations.wasSlow ? 'warn' : 'verbose';

					this.logger[logLevel]('Outbound HTTP request complete', {
						requestId,
						hostname: this.hostname,
						port: this.port,
						method: options.method,
						path: options.path,
						status: res.statusCode,
						contentLength,
						...durations
					});

					res.body = data;
					res.timing = durations;

					if (res.headers['content-type'] === 'application/json') {
						try {
							res.json = JSON.parse(data);
						}

						catch (error) {
							this.logger.warn('HTTP response content-type was application/json, but the payload was unparsable', { requestId });
						}
					}

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

			const timer = new HttpTimer(req, params.slowThreshold || this.slowThreshold);

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
