/**
 * Search endpoint and related cache/bootstrap metrics.
 */

const client = require('prom-client');

/** Search queries that required a replica retry due to staleness or no results. */
const searchReplicaRetryTotal = new client.Counter({
  name: 'search_replica_retry_total',
  help: 'Search queries that retried from replica to primary due to staleness or no results',
  labelNames: ['scope', 'reason'],
});

const searchDbBackendTotal = new client.Counter({
  name: 'search_db_backend_total',
  help: 'Search DB transactions by backend and outcome',
  labelNames: ['kind', 'backend', 'result'],
});

/** Number of results returned per search query (histogram for distribution visibility). */
const searchResultsReturnedHistogram = new client.Histogram({
  name: 'search_results_returned',
  help: 'Number of results returned per search query',
  labelNames: ['scope', 'fallback_method'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 250],
});

/** Search queries throttled/capped by load shedding or result limit. */
const searchThrottledTotal = new client.Counter({
  name: 'search_throttled_total',
  help: 'Search queries throttled by overload stage or result capping',
  labelNames: ['stage', 'reason'],
});

/** Query duration for different search paths (FTS vs trigram vs unscoped). */
const searchQueryDurationMs = new client.Histogram({
  name: 'search_query_duration_ms',
  help: 'Database query duration for search endpoint (excluding HTTP handler overhead)',
  labelNames: ['scope', 'fallback_method', 'stage'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Cache outcomes for the new channel access Redis cache. */
const channelAccessCacheTotal = new client.Counter({
  name: 'channel_access_cache_total',
  help: 'Cache outcomes for the channel access Redis cache',
  labelNames: ['result'],
});

/** How many channels a websocket auto-subscribes to on connect. */
const wsBootstrapChannelsHistogram = new client.Histogram({
  name: 'ws_bootstrap_channels',
  help: 'Number of websocket auto-subscribe channels per successful bootstrap list load',
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Redis message-list first-page bust failed after POST/PATCH/DELETE (TTL backstop applies). */
const messageCacheBustFailuresTotal = new client.Counter({
  name: 'message_cache_bust_failures_total',
  help: 'GET /messages first-page cache bust threw (Redis DEL/INCR)',
  labelNames: ['target'],
});

/** Wall time for message list cache bust (DEL + epoch INCR), one observation per bust. */
const messageCacheBustWallDurationMs = new client.Histogram({
  name: 'message_cache_bust_wall_duration_ms',
  help: 'Wall-clock duration of message list cache bust (pipeline or sequential)',
  labelNames: ['scope'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Meili freshness supplement query execution time in milliseconds. */
const searchFreshnessQueryDurationMs = new client.Histogram({
  name: 'search_freshness_query_duration_ms',
  help: 'Database query duration for Meili search freshness supplement (recent message scan)',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Cache hits for Meili freshness candidate results in Redis (incremented per hit). */
const searchFreshnessCacheHitsTotal = new client.Counter({
  name: 'search_freshness_cache_hits_total',
  help: 'Cache hits for Meili search freshness supplement results in Redis',
});

/** Cache misses / bypass reasons for Meili freshness candidate results in Redis. */
const searchFreshnessCacheMissesTotal = new client.Counter({
  name: 'search_freshness_cache_misses_total',
  help: 'Cache misses or bypass reasons for Meili search freshness supplement results in Redis',
  labelNames: ['reason'],
});

/** Freshness supplement queries skipped for short queries (< 3 chars). */
const searchFreshnessSkippedShortQueryTotal = new client.Counter({
  name: 'search_freshness_skipped_short_query_total',
  help: 'Freshness supplement queries skipped due to short query length (< 3 chars)',
});

module.exports = {
  searchReplicaRetryTotal,
  searchDbBackendTotal,
  searchResultsReturnedHistogram,
  searchThrottledTotal,
  searchQueryDurationMs,
  channelAccessCacheTotal,
  wsBootstrapChannelsHistogram,
  messageCacheBustFailuresTotal,
  messageCacheBustWallDurationMs,
  searchFreshnessQueryDurationMs,
  searchFreshnessCacheHitsTotal,
  searchFreshnessCacheMissesTotal,
  searchFreshnessSkippedShortQueryTotal,
};
