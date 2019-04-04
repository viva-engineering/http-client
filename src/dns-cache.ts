
import dnscache from 'dnscache';

export interface DnsCacheParams {
	enable: boolean;
	ttl: number;
	cachesize: number;
}

let dnsCache;

export const configureDnsCache = (params: DnsCacheParams) => {
	dnscache(params);

	if (params.enable) {
		dnsCache = dnscache.internalCache;
	}
};

export const invalidateCacheForDomain = (domain: string) => {
	if (! dnsCache) {
		return;
	}

	const pattern = `lookup_${domain}_`;

	Object.keys(dnsCache.data).forEach((key) => {
		if (key.indexOf(pattern) === 0) {
			delete dnsCache.data[key];
		}
	});
};
