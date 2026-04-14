'use strict';

const { endpointListCacheTotal, endpointListCacheBypassTotal, endpointListCacheInvalidationsTotal } = require('./metrics');

export type ListCacheEndpoint =
  | 'communities'
  | 'channels'
  | 'messages_channel'
  | 'messages_conversation'
  | 'conversations';

export type ListCacheResult = 'hit' | 'miss' | 'coalesced';
export type ListCacheBypassReason = 'pagination' | 'no_target' | 'redis_error';
export type ListCacheInvalidationReason = 'write' | 'membership' | 'delete' | 'other';

export function recordEndpointListCache(endpoint: ListCacheEndpoint, result: ListCacheResult): void {
  endpointListCacheTotal.inc({ endpoint, result });
}

export function recordEndpointListCacheBypass(endpoint: ListCacheEndpoint, reason: ListCacheBypassReason): void {
  endpointListCacheBypassTotal.inc({ endpoint, reason });
}

export function recordEndpointListCacheInvalidation(endpoint: ListCacheEndpoint, reason: ListCacheInvalidationReason): void {
  endpointListCacheInvalidationsTotal.inc({ endpoint, reason });
}
