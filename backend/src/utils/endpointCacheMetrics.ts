
const { endpointListCacheTotal, endpointListCacheBypassTotal, endpointListCacheInvalidationsTotal } = require('./metrics');

export type ListCacheEndpoint =
  | 'communities'
  | 'channels'
  | 'messages_channel'
  | 'messages_conversation'
  | 'conversations';

export type ListCacheResult = 'hit' | 'miss' | 'coalesced';
export type ListCacheBypassReason = 'pagination' | 'no_target' | 'redis_error' | 'pressure' | 'timeout';
/**
 * Normalized, low-cardinality invalidation reasons for `endpoint_list_cache_invalidations_total`.
 * Do not pass user/channel/conversation IDs as labels or embedded in reason strings.
 */
export type ListCacheInvalidationReason =
  /** Volatile first-page message list cache (not structural lists). */
  | 'message_list_volatile'
  /** Conversation create/delete/rename or non-membership structural changes. */
  | 'structural_conversation_change'
  /** Channel create/delete/rename under a community. */
  | 'structural_channel_change'
  /** Community list membership shape (create/delete community visibility). */
  | 'structural_community_change'
  /** Participant added/removed, join/leave, role — anything that changes membership rows. */
  | 'membership_change';

export function recordEndpointListCache(endpoint: ListCacheEndpoint, result: ListCacheResult): void {
  endpointListCacheTotal.inc({ endpoint, result });
}

export function recordEndpointListCacheBypass(endpoint: ListCacheEndpoint, reason: ListCacheBypassReason): void {
  endpointListCacheBypassTotal.inc({ endpoint, reason });
}

export function recordEndpointListCacheInvalidation(endpoint: ListCacheEndpoint, reason: ListCacheInvalidationReason): void {
  endpointListCacheInvalidationsTotal.inc({ endpoint, reason });
}
