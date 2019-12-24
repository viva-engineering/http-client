
import { Logger } from '@viva-eng/logger';

export interface Headers {
	[header: string]: string | string[];
}

export interface HttpClientParams {
	hostname: string;
	port: number;
	ssl: boolean;
	headers?: Headers;
	logger: Logger;
	timeout?: number;
	options?: any;
}

export interface HttpRequestOptions {
	body?: string | Buffer;
	headers?: Headers;
	timeout?: number;
	options?: any;
}

export interface HttpResponse<Json> {
	req: any;
	res: any;
	status: number;
	headers: Headers;
	body: {
		raw: string;
		json: Json;
	};
}

export abstract class HttpClient {
	public readonly hostname: string;
	public readonly port: number;
	public readonly ssl: boolean;
	public readonly headers?: Headers;
	public readonly logger: Logger;
	public readonly timeout: number;
	public readonly options?: any;

	constructor(params: HttpClientParams) {
		this.hostname = params.hostname;
		this.port = params.port;
		this.ssl = params.ssl;
		this.headers = params.headers || { };
		this.logger = params.logger;
		this.timeout = params.timeout || 0;
		this.options = params.options;
	}

	protected abstract makeRequest<T>(method: string, path: string, params: HttpRequestOptions) : Promise<HttpResponse<T>>;

	public request<T>(method: string, path: string, params: HttpRequestOptions) {
		return this.makeRequest<T>(method, path, params);
	}

	public get<T>(path: string, params: HttpRequestOptions) {
		return this.request<T>('GET', path, params);
	}

	public post<T>(path: string, params: HttpRequestOptions) {
		return this.request<T>('POST', path, params);
	}

	public put<T>(path: string, params: HttpRequestOptions) {
		return this.request<T>('PUT', path, params);
	}

	public patch<T>(path: string, params: HttpRequestOptions) {
		return this.request<T>('PATCH', path, params);
	}

	public delete<T>(path: string, params: HttpRequestOptions) {
		return this.request<T>('DELETE', path, params);
	}
}
