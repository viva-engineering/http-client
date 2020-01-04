
import { HttpClient as BaseClient, HttpClientParams, HttpRequestOptions, HttpResponse } from './http-client';

// 
// This is some stupid shit...
// Typescript will not allow me to properly type these two classes, despite them both being fully
// defined (no more abstract anywhere) and both implementing identical interfaces. So... We're going
// to create a fake "shim" class that will never actually be used aside from borrowing its type
// after we define it.
// 
export class HttpClient extends BaseClient {
	protected makeRequest<T>(method: string, path: string, params: HttpRequestOptions) : Promise<HttpResponse<T>> {
		return new Promise((resolve) => resolve());
	}
}

export interface HttpClientConstructor {
	new (params: HttpClientParams) : HttpClient;
}
