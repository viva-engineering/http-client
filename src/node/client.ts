
import { request as httpsRequest } from 'https';
import { request as httpRequest, ClientRequest, IncomingMessage, RequestOptions } from 'http';
import { Headers, HttpClient, HttpClientParams, HttpRequestOptions, HttpResponse } from '../http-client';
import { HttpTimer } from './timer';
import { invalidateCacheForDomain } from './dns-cache';
import { Logger } from '@viva-eng/logger';

let nextRequestId = 1;

const networkErrors = new Set([
	'ECONNRESET', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN'
]);

export class NodeHttpClient extends HttpClient {
	protected makeRequest<T>(method: string, path: string, params: HttpRequestOptions) : Promise<HttpResponse<T>> {
		const requestId = nextRequestId++;

		if (requestId >= Number.MAX_SAFE_INTEGER) {
			nextRequestId = 1;
		}

		const timeout = params.timeout == null ? this.timeout : params.timeout;
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

					const result: HttpResponse<T> = {
						req,
						res,
						status: res.statusCode,
						headers: res.headers,
						body: {
							raw: data,
							json: getJson(res, data, requestId, this.logger)
						}
					};

					resolve(result);
				});
			};

			const req = this.ssl
				? httpsRequest(options, onResponse)
				: httpRequest(options, onResponse);

			const timer = new HttpTimer(req);

			let aborted = false;

			req.on('error', (error) => {
				if (aborted) {
					return;
				}

				this.logger.warn('An error occured while trying to make an HTTP request', { requestId, error });

				if (networkErrors.has((error as any).code)) {
					invalidateCacheForDomain(this.hostname);
				}

				reject(error);
			});

			if (timeout) {
				req.setTimeout(timeout, () => {
					this.logger.warn('HTTP request timed out', { requestId, timeout });

					aborted = true;
					req.abort();

					reject(new Error(`HTTP request timed out; requestId=${requestId} timeout=${timeout}`));
				});
			}

			if (params.body && method !== 'GET' && method !== 'HEAD') {
				req.write(params.body);
			}

			req.end();
		});
	}
}

const getJson = <T>(res: IncomingMessage, data: string, requestId: number, logger: Logger) : T => {
	if (res.headers['content-type'] === 'application/json') {
		try {
			return JSON.parse(data);
		}

		catch (error) {
			logger.warn('HTTP response content-type was application/json, but the payload was unparsable', { requestId });
		}
	}
};
