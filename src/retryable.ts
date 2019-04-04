
import { RequestOptions } from 'http';
import { Response } from './index';
import { invalidateCacheForDomain } from './dns-cache';

export const TimeoutAbort = Symbol('timeout abort');

export interface NetworkError extends Error {
	code: string;
}

export interface IsRetryableCallback {
	(outcome: Response | Error | Symbol, options: RequestOptions): boolean;
}

const retryableNetworkError = new Set([
	'ECONNRESET', 'ENOTFOUND', 'ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN'
]);

export const retryNetworkErrors = (outcome: Response | NetworkError | Symbol, options: RequestOptions) : boolean => {
	if (outcome === TimeoutAbort) {
		return true;
	}

	if (outcome instanceof Error && outcome.code) {
		const isRetryable = retryableNetworkError.has(outcome.code);

		// In the event of network errors, dump the DNS cache before trying again
		if (isRetryable) {
			invalidateCacheForDomain(options.host);
		}

		return isRetryable;
	}
};
