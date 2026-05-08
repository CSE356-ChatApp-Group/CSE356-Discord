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

/** End-to-end wall time for the Meili empty-candidate freshness rescue path. */
const searchFreshnessRescueWallDurationMs = new client.Histogram({
  name: 'search_freshness_rescue_wall_duration_ms',
  help: 'Wall-clock duration for Meili empty-candidate freshness rescue attempts',
  labelNames: ['result'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Postgres recheck duration after Meili/freshness returns candidate message IDs. */
const meiliRecheckDurationMs = new client.Histogram({
  name: 'meili_recheck_duration_ms',
  help: 'Postgres access/deleted/latest-content recheck duration for Meili candidate IDs',
  labelNames: ['source', 'backend'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

/** Search route overhead outside the main search client call. */
const searchHandlerOverheadMs = new client.Histogram({
  name: 'search_handler_overhead_ms',
  help: 'GET /search route wall time outside searchClient.search execution',
  labelNames: ['scope', 'status'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

/** GET /search parse + scope-resolution overhead before backend search call. */
const searchRouteParseScopeMs = new client.Histogram({
  name: 'search_route_parse_scope_ms',
  help: 'GET /search parse/validation/scope-resolution wall time before backend search execution',
  labelNames: ['scope', 'status'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
});

/** OpenSearch candidate fetch latency (raw _search call only). */
const opensearchCandidateFetchMs = new client.Histogram({
  name: 'opensearch_candidate_fetch_ms',
  help: 'OpenSearch candidate fetch wall time (/_search) for GET /search',
  labelNames: ['scope', 'status'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Alias for OpenSearch candidate fetch latency (requested dashboard metric). */
const opensearchSearchDurationMs = new client.Histogram({
  name: 'opensearch_search_duration_ms',
  help: 'OpenSearch candidate search duration for GET /search candidate retrieval',
  labelNames: ['scope', 'status'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Candidate recheck (Postgres) latency after OpenSearch candidate retrieval. */
const candidateRecheckMs = new client.Histogram({
  name: 'candidate_recheck_ms',
  help: 'Postgres candidate recheck wall time after OpenSearch candidate retrieval',
  labelNames: ['scope', 'status'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Response formatting time after strict filtering/page slicing. */
const searchFormattingMs = new client.Histogram({
  name: 'search_formatting_ms',
  help: 'Search result formatting wall time after backend retrieval/recheck',
  labelNames: ['scope'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250],
});

/** End-to-end search backend execution time (inside search client backend implementation). */
const searchTotalMs = new client.Histogram({
  name: 'search_total_ms',
  help: 'Search backend total wall time from candidate fetch through final result build',
  labelNames: ['backend', 'scope', 'status'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** OpenSearch candidate count distribution per request. */
const opensearchCandidateCount = new client.Histogram({
  name: 'opensearch_candidate_count',
  help: 'OpenSearch candidate ID count returned before Postgres recheck',
  labelNames: ['scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000],
});

/** Alias metric requested for dashboard parity. */
const candidateCount = new client.Histogram({
  name: 'candidate_count',
  help: 'Candidate count distribution before recheck',
  labelNames: ['backend', 'scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000],
});

/** Recheck input count distribution (candidate IDs sent to Postgres recheck). */
const opensearchRecheckInputCount = new client.Histogram({
  name: 'opensearch_recheck_input_count',
  help: 'Candidate count sent into Postgres recheck for OpenSearch backend',
  labelNames: ['scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 2000],
});

/** Recheck output count distribution (rows surviving access/deleted/latest-content checks). */
const opensearchRecheckOutputCount = new client.Histogram({
  name: 'opensearch_recheck_output_count',
  help: 'Rows returned from Postgres recheck for OpenSearch backend before strict filtering',
  labelNames: ['scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000],
});

/** Alias metric requested for dashboard parity. */
const recheckOutputCount = new client.Histogram({
  name: 'recheck_output_count',
  help: 'Recheck output count distribution',
  labelNames: ['backend', 'scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250, 500, 1000],
});

/** Final result count after strict filtering and pagination. */
const finalResultCount = new client.Histogram({
  name: 'final_result_count',
  help: 'Final result count distribution after strict filtering and paging',
  labelNames: ['backend', 'scope'],
  buckets: [0, 1, 2, 5, 10, 20, 50, 100, 250],
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
  searchFreshnessRescueWallDurationMs,
  meiliRecheckDurationMs,
  searchHandlerOverheadMs,
  searchRouteParseScopeMs,
  opensearchCandidateFetchMs,
  opensearchSearchDurationMs,
  candidateRecheckMs,
  searchFormattingMs,
  searchTotalMs,
  opensearchCandidateCount,
  candidateCount,
  opensearchRecheckInputCount,
  opensearchRecheckOutputCount,
  recheckOutputCount,
  finalResultCount,
  searchFreshnessCacheHitsTotal,
  searchFreshnessCacheMissesTotal,
  searchFreshnessSkippedShortQueryTotal,
};
