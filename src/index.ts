
import { isNode, isBrowser } from './environment';
import { HttpClient as BaseClient } from './http-client';
import { HttpClientConstructor } from './shim';
import { Logger } from '@viva-eng/logger';

import { Headers, HttpClientParams, HttpRequestOptions, HttpResponse } from './http-client';
export { Headers, HttpClientParams, HttpRequestOptions, HttpResponse } from './http-client';

export { HttpClient as HttpClientWrapper } from './shim';

export let NodeHttpClient: typeof import('./node/client').NodeHttpClient;
export let BrowserHttpClient: typeof import('./browser/client').BrowserHttpClient;

export let configureDnsCache: typeof import('./node/dns-cache').configureDnsCache;

if (isNode) {
	NodeHttpClient = require('./node/client').NodeHttpClient;
	configureDnsCache = require('./node/dns-cache').configureDnsCache;
}

if (isBrowser) {
	BrowserHttpClient = require('./browser/client').BrowserHttpClient;
}

export const HttpClient: HttpClientConstructor = (isNode ? NodeHttpClient : BrowserHttpClient) as any;

/**
 * Special non-logging logger that can be used in cases where no logging behavior
 * at all is desired
 */
export const NO_LOGGER: Logger = Object.freeze({
	error() { },
	warn() { },
	info() { },
	verbose() { },
	debug() { },
	silly() { }
}) as any;
