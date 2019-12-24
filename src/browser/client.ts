
import { Logger } from '@viva-eng/logger';
import { Headers, HttpClient, HttpClientParams, HttpRequestOptions, HttpResponse } from '../http-client';

let nextRequestId = 1;

export class BrowserHttpClient extends HttpClient {
	protected makeRequest<T>(method: string, path: string, params: HttpRequestOptions) : Promise<HttpResponse<T>> {
		const requestId = nextRequestId++;

		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			const scheme = this.ssl ? 'https' : 'http';
			const port = getPortString(this.ssl, this.port);

			xhr.addEventListener('load', () => {
				const headers = processHeaders(xhr.getAllResponseHeaders());

				const result: HttpResponse<T> = {
					req: xhr,
					res: xhr,
					status: statusCode(xhr),
					headers: headers,
					body: {
						raw: xhr.responseText,
						json: getJson(headers, xhr.responseText, requestId, this.logger)
					}
				};

				resolve(result);
			});

			xhr.addEventListener('error', (error) => {
				reject(error);
			});

			xhr.open(method, `${scheme}://${this.hostname}${port}${path}`);

			if (this.headers) {
				applyHeaders(xhr, this.headers);
			}

			if (params.headers) {
				applyHeaders(xhr, this.headers);
			}

			xhr.send(params.body ? params.body : null);
		});
	}
}

/**
 * If the port number provided is the standard default for that protocol, we will
 * exclude it from the url. Otherwise, we need the port number
 */
const getPortString = (ssl: boolean, port: number) => {
	if (port) {
		if (ssl) {
			if (port === 443) {
				return '';
			}

			return `:${port}`;
		}

		if (port === 80) {
			return '';
		}

		return `:${port}`;
	}

	return '';
};

const applyHeaders = (xhr: XMLHttpRequest, headers: Headers) => {
	Object.keys(headers).forEach((header) => {
		const value = headers[header];

		if (Array.isArray(value)) {
			value.forEach((value) => {
				xhr.setRequestHeader(header, value);
			});
		}

		else {
			xhr.setRequestHeader(header, value);
		}
	});
};

interface WithStatusCode {
	status?: number;
	statusCode?: number;
}

const statusCode = (req: WithStatusCode) : number => {
	return req.status == null ? req.statusCode : req.status;
};

const getJson = <T>(headers: Headers, data: string, requestId: number, logger: Logger) : T => {
	if (headers['content-type'] === 'application/json') {
		try {
			return JSON.parse(data);
		}

		catch (error) {
			logger.warn('HTTP response content-type was application/json, but the payload was unparsable', { requestId });
		}
	}
};

const processHeaders = (rawHeaders: string) : Headers => {
	const headers: Headers = { };

	const lines = rawHeaders.split(/[\r\n]+/);

	lines.forEach((line) => {
		const parts = line.split(': ');
		const header = parts.shift();
		const value = parts.join(': ');

		if (headers[header]) {
			if (! Array.isArray(headers[header])) {
				headers[header] = [ headers[header] as string ];
			}

			(headers[header] as string[]).push(value);
		}
	});

	return headers;
};
