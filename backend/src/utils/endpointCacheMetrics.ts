'use strict';

const { endpointListCacheTotal } = require('./metrics');

export type ListCacheEndpoint =
  | 'communities'
  | 'channels'
  | 'messages_channel'
  | 'messages_conversation'
  | 'conversations';

export type ListCacheResult = 'hit' | 'miss' | 'coalesced';

export function recordEndpointListCache(endpoint: ListCacheEndpoint, result: ListCacheResult): void {
  endpointListCacheTotal.inc({ endpoint, result });
}
