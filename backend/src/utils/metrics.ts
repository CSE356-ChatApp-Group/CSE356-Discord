'use strict';

const client = require('prom-client');

client.register.setDefaultLabels({
  service: 'chatapp-api',
  env: process.env.NODE_ENV || 'development',
});

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_server_requests_total',
  help: 'Total number of completed HTTP requests',
  labelNames: ['method', 'route', 'status_class'],
});

const httpRequestDurationMs = new client.Histogram({
  name: 'http_server_request_duration_ms',
  help: 'Latency of completed HTTP requests in milliseconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Client disconnected or response aborted before `finish` (correlates with k6 status 0). */
const httpRequestsAbortedTotal = new client.Counter({
  name: 'http_server_requests_aborted_total',
  help: 'HTTP responses where the connection closed before the response finished (no finish event)',
  labelNames: ['method', 'route'],
});

/** Incremented when middleware rejects a request due to event-loop lag (overload shed). */
const httpOverloadShedTotal = new client.Counter({
  name: 'http_overload_shed_total',
  help: 'HTTP requests rejected early by event-loop lag shedding (503 before route handlers)',
});

// ── Presence fanout ────────────────────────────────────────────────────────────

/**
 * Counts every call to setPresence(), labelled by the target status and
 * whether the fanout was suppressed by the overload guard.
 *
 * Labels:
 *   status    – online | idle | away | offline
 *   throttled – true | false
 */
const presenceFanoutTotal = new client.Counter({
  name: 'presence_fanout_total',
  help: 'Number of presence state changes, partitioned by status and whether the Redis fanout was throttled',
  labelNames: ['status', 'throttled'],
});

/**
 * Distribution of how many local WebSocket clients received a message
 * when the Redis pub/sub handler fired.
 *
 * Labels:
 *   channel_type – user | channel | conversation
 */
const fanoutRecipientsHistogram = new client.Histogram({
  name: 'presence_fanout_recipients',
  help: 'Number of local WebSocket recipients per Redis pub/sub delivery, by channel type',
  labelNames: ['channel_type'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500],
});

// ── Async side-effect queue ───────────────────────────────────────────────────

const sideEffectQueueDepth = new client.Gauge({
  name: 'side_effect_queue_depth',
  help: 'Number of pending async side-effect jobs waiting to be processed',
  labelNames: ['queue'],
});

const sideEffectQueueActiveWorkers = new client.Gauge({
  name: 'side_effect_queue_active_workers',
  help: 'Number of workers currently draining the async side-effect queue',
  labelNames: ['queue'],
});

const sideEffectQueueDelayMs = new client.Histogram({
  name: 'side_effect_queue_delay_ms',
  help: 'Time a side-effect job spends waiting in the queue before execution',
  labelNames: ['queue', 'name'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const sideEffectJobDurationMs = new client.Histogram({
  name: 'side_effect_job_duration_ms',
  help: 'Execution time of async side-effect jobs',
  labelNames: ['queue', 'name', 'status'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const sideEffectQueueDroppedTotal = new client.Counter({
  name: 'side_effect_queue_dropped_total',
  help: 'Number of side-effect jobs dropped before execution due to overload safeguards',
  labelNames: ['queue', 'name', 'reason'],
});

// ── Auth cost / throttling ───────────────────────────────────────────────────

const authBcryptDurationMs = new client.Histogram({
  name: 'auth_bcrypt_duration_ms',
  help: 'Time spent performing bcrypt password hashing and comparison for auth-related flows',
  labelNames: ['operation', 'result', 'rounds'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const authBcryptActive = new client.Gauge({
  name: 'auth_bcrypt_active',
  help: 'Number of bcrypt operations currently executing inside the app-level bcrypt gate',
});

const authBcryptWaiters = new client.Gauge({
  name: 'auth_bcrypt_waiters',
  help: 'Number of bcrypt operations currently waiting in the app-level bcrypt queue',
});

const authBcryptQueueRejectsTotal = new client.Counter({
  name: 'auth_bcrypt_queue_rejects_total',
  help: 'Number of bcrypt operations rejected or timed out before execution',
  labelNames: ['reason'],
});

const authRateLimitHitsTotal = new client.Counter({
  name: 'auth_rate_limit_hits_total',
  help: 'Number of auth requests rejected by the auth-specific rate limiter',
  labelNames: ['route'],
});

/** POST /messages rejected after access check (channel private / not a DM participant). */
const messagePostAccessDeniedTotal = new client.Counter({
  name: 'message_post_access_denied_total',
  help: 'Message create rejected with 403 after target access check',
  labelNames: ['reason'],
});

/** POST /api/v1/messages only — exact HTTP status (correlates with grader sendMessage failures). */
const messageIngestStreamAppendedTotal = new client.Counter({
  name: 'message_ingest_stream_appended_total',
  help: 'Redis Stream XADD for message ingest log',
  labelNames: ['result'],
});

const messageIngestStreamConsumedTotal = new client.Counter({
  name: 'message_ingest_stream_consumed_total',
  help: 'Redis Stream messages ACKed by ingest consumer',
  labelNames: ['result'],
});

const messagePostResponseTotal = new client.Counter({
  name: 'message_post_response_total',
  help: 'POST /api/v1/messages responses by HTTP status code',
  labelNames: ['status_code'],
});

/**
 * Second POST /messages with the same Idempotency-Key while the first holds the
 * Redis NX lease: polls until replay or deadline (see router exponential backoff).
 */
const messagePostIdempotencyPollTotal = new client.Counter({
  name: 'message_post_idempotency_poll_total',
  help: 'POST /messages idempotency duplicate-lease poll outcomes',
  labelNames: ['outcome'],
});

const messagePostIdempotencyPollWaitMs = new client.Histogram({
  name: 'message_post_idempotency_poll_wait_ms',
  help: 'Milliseconds spent in duplicate-lease wait loop before 201 replay or 409',
  labelNames: ['outcome'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** WebSocket connection outcomes (upgrade + auth + bootstrap failures). */
const wsConnectionResultTotal = new client.Counter({
  name: 'ws_connection_result_total',
  help: 'WebSocket outcomes after upgrade (auth failures, subscribe failures, etc.)',
  labelNames: ['result'],
});

/** Frames skipped or sockets killed due to WS send backpressure (slow consumers). */
const wsBackpressureEventsTotal = new client.Counter({
  name: 'ws_backpressure_events_total',
  help: 'WebSocket backpressure events (dropped frames or terminated slow consumers)',
  labelNames: ['action'],
});

/** Per-socket outbound queue depth after enqueue (message:* vs best-effort). */
const wsOutboundQueueDepthHistogram = new client.Histogram({
  name: 'ws_outbound_queue_depth',
  help: 'Depth of per-socket outbound WS frame queue after enqueue',
  labelNames: ['priority'],
  buckets: [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
});

/** Total frames waiting in outbound queues on this Node process. */
const wsOutboundQueuedFramesGauge = new client.Gauge({
  name: 'ws_outbound_queued_frames',
  help: 'Total outbound WS frames queued across all sockets on this process',
});

/** message:* enqueue yielded waiting for bounded queue capacity. */
const wsOutboundQueueBlockWaitsTotal = new client.Counter({
  name: 'ws_outbound_queue_block_waits_total',
  help: 'Times a message:* enqueue waited for queue capacity (setImmediate yield)',
});

/** Best-effort frames dropped at enqueue when queue at cap (never used for message:*). */
const wsOutboundQueueDroppedBestEffortTotal = new client.Counter({
  name: 'ws_outbound_queue_dropped_best_effort_total',
  help: 'Non-message frames dropped because outbound queue was at max depth',
});

/** Outbound queue drain batches (setImmediate ticks). */
const wsOutboundDrainBatchesTotal = new client.Counter({
  name: 'ws_outbound_drain_batches_total',
  help: 'WebSocket outbound queue drain batches executed',
});

/** WebSocket disconnects by close code and whether bootstrap had completed. */
const wsDisconnectsTotal = new client.Counter({
  name: 'ws_disconnects_total',
  help: 'WebSocket disconnects by close code and bootstrap state',
  labelNames: ['code', 'clean', 'bootstrap_ready'],
});

/** WebSocket connection lifetime before close. */
const wsConnectionLifetimeMs = new client.Histogram({
  name: 'ws_connection_lifetime_ms',
  help: 'WebSocket connection lifetime in milliseconds before the socket closed',
  labelNames: ['close_code', 'bootstrap_ready'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 900000],
});

/** User reconnected shortly after a prior disconnect (helps correlate isolated delivery misses). */
const wsReconnectsTotal = new client.Counter({
  name: 'ws_reconnects_total',
  help: 'WebSocket reconnects that occurred shortly after a prior disconnect',
  labelNames: ['window'],
});

/** Gap between the last known disconnect and a subsequent reconnect for the same user. */
const wsReconnectGapMs = new client.Histogram({
  name: 'ws_reconnect_gap_ms',
  help: 'Milliseconds between a recent websocket disconnect and the next reconnect for the same user',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000],
});

/** Reconnect replay query outcomes so we can verify replay is bounded under load. */
const wsReplayQueryTotal = new client.Counter({
  name: 'ws_replay_query_total',
  help: 'Reconnect replay query outcomes for websocket missed-message backfill',
  labelNames: ['result'],
});

/** Wall-clock duration for reconnect replay DB work (successful or failed-open). */
const wsReplayQueryDurationMs = new client.Histogram({
  name: 'ws_replay_query_duration_ms',
  help: 'Milliseconds spent loading reconnect replay messages from Postgres',
  labelNames: ['result'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000],
});

/**
 * Redis PUBLISH failures from realtime fanout (correlate with DM/channel delivery
 * gaps when HTTP 201 still returned before hardening, or with infra issues).
 */
const redisFanoutPublishFailuresTotal = new client.Counter({
  name: 'redis_fanout_publish_failures_total',
  help: 'Failed Redis PUBLISH calls for WebSocket fanout',
  labelNames: ['channel_prefix'],
});

/** Concurrent hard-deletes caused FK violation on last_message_id; cleared and retried. */
const messageLastMessageRepointFkRetryTotal = new client.Counter({
  name: 'message_last_message_repoint_fk_retry_total',
  help: 'Last-message repoint hit channels_last_message_id_fkey / conversations FK race and retried after clearing pointers',
  labelNames: ['scope'],
});

/** Wall-clock time for WS auto-subscribe bootstrap (list + batched subscribe, incl. retries). */
const wsBootstrapWallDurationMs = new client.Histogram({
  name: 'ws_bootstrap_wall_duration_ms',
  help: 'Milliseconds from WS connection start until auto-subscribe bootstrap completes successfully',
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000],
});

/** Cache outcomes for Redis-backed realtime fanout target lists. */
const fanoutTargetCacheTotal = new client.Counter({
  name: 'fanout_target_cache_total',
  help: 'Cache outcomes for Redis-backed realtime fanout target lists',
  labelNames: ['path', 'result'],
});

/**
 * Conversation fanout target cache load saw a version bump during the PG round-trip
 * (membership invalidation raced the in-flight loader), or gave up caching after max retries.
 */
const conversationFanoutTargetsCacheVersionRetryTotal = new client.Counter({
  name: 'conversation_fanout_targets_cache_version_retry_total',
  help: 'Conversation fanout cache load retried or returned uncached after version races with invalidation',
  labelNames: ['outcome'],
});

/** Wall-clock duration of realtime fanout stages (lookup, publish, total). */
const fanoutPublishDurationMs = new client.Histogram({
  name: 'fanout_publish_duration_ms',
  help: 'Wall-clock duration of realtime fanout stages in milliseconds',
  labelNames: ['path', 'stage'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Number of Redis publish targets per realtime fanout operation. */
const fanoutPublishTargetsHistogram = new client.Histogram({
  name: 'fanout_publish_targets',
  help: 'Number of Redis publish targets per realtime fanout operation',
  labelNames: ['path'],
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Cache outcomes for WS bootstrap subscription lists. */
const wsBootstrapListCacheTotal = new client.Counter({
  name: 'ws_bootstrap_list_cache_total',
  help: 'Cache outcomes for websocket auto-subscribe channel lists',
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

// ── PG pool health ─────────────────────────────────────────────────────────────

const pgPoolTotal = new client.Gauge({
  name: 'pg_pool_total',
  help: 'Total number of clients in the pg pool (idle + active)',
});
const pgPoolIdle = new client.Gauge({
  name: 'pg_pool_idle',
  help: 'Number of idle clients in the pg pool',
});
const pgPoolWaiting = new client.Gauge({
  name: 'pg_pool_waiting',
  help: 'Number of requests waiting for a pg pool client (queue depth)',
});

/** Immediate rejects when checkout queue hits POOL_CIRCUIT_BREAKER_QUEUE (scale DB vs app). */
const pgPoolCircuitBreakerRejectsTotal = new client.Counter({
  name: 'pg_pool_circuit_breaker_rejects_total',
  help: 'Requests rejected because the pg pool waiting queue exceeded the circuit breaker threshold',
});

/**
 * Errors from pool.query after checkout (timeouts, refused, etc.).
 * Use this with pg_pool_waiting and circuit_breaker_rejects to see whether bursts are DB path vs JS.
 */
const pgPoolOperationErrorsTotal = new client.Counter({
  name: 'pg_pool_operation_errors_total',
  help: 'Errors from pg pool operations, by coarse reason',
  labelNames: ['operation', 'reason'],
});

/**
 * Count of successful `query()` / wrapped `client.query()` round-trips per HTTP request
 * (AsyncLocalStorage). Includes BEGIN/COMMIT/ROLLBACK from transactions. Simple reads can be
 * single digits; heavy routes (e.g. `/api/v1/messages/`) often land much higher — interpret high p95
 * only when histogram buckets
 * extend above observed values (otherwise quantiles clip at the top bucket).
 */
const pgQueriesPerRequestHistogram = new client.Histogram({
  name: 'pg_queries_per_http_request',
  help: 'Successful Postgres round-trips per HTTP request (includes txn control statements)',
  labelNames: ['route'],
  // Fibonacci-ish spacing; extend past 377 so histogram_quantile does not pile every hot
  // route at the same top finite bucket (looks like identical p95 across routes).
  buckets: [
    0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377,
    610, 987, 1597, 2584, 4181, 6765, 10946,
  ],
});
const pgBusinessSqlQueriesPerRequestHistogram = new client.Histogram({
  name: 'pg_business_sql_queries_per_http_request',
  help: 'Successful Postgres business-SQL round-trips per HTTP request (excludes BEGIN/COMMIT/ROLLBACK)',
  labelNames: ['route'],
  buckets: [
    0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377,
    610, 987, 1597, 2584, 4181, 6765, 10946,
  ],
});

/** Redis-backed list endpoint cache: hit (served from Redis), miss (DB load), coalesced (singleflight waiter). */
const endpointListCacheTotal = new client.Counter({
  name: 'endpoint_list_cache_total',
  help: 'Redis list cache outcomes for hot GET list endpoints',
  labelNames: ['endpoint', 'result'],
});
const endpointListCacheBypassTotal = new client.Counter({
  name: 'endpoint_list_cache_bypass_total',
  help: 'Redis list cache bypasses by endpoint and reason',
  labelNames: ['endpoint', 'reason'],
});
const endpointListCacheInvalidationsTotal = new client.Counter({
  name: 'endpoint_list_cache_invalidations_total',
  help: 'Redis list cache invalidations by endpoint and reason',
  labelNames: ['endpoint', 'reason'],
});

/** Optional RUM POST /api/v1/rum rate limiter only (not general API traffic). */
const apiRateLimitHitsTotal = new client.Counter({
  name: 'api_rate_limit_hits_total',
  help: 'Requests rejected by optional rate limiters (scope=rum for POST /rum)',
  labelNames: ['scope'],
});

/** Browser timing vitals (LCP, INP, FCP, TTFB) in seconds. */
const clientWebVitalTimingSeconds = new client.Histogram({
  name: 'client_web_vital_timing_seconds',
  help: 'Browser timing web vitals (seconds)',
  labelNames: ['name'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
});

/** Cumulative Layout Shift score (0–1, dimensionless). */
const clientWebVitalClsScore = new client.Histogram({
  name: 'client_web_vital_cls_score',
  help: 'Cumulative Layout Shift (CLS) scores from optional RUM',
  labelNames: ['name'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
});

const clientRumBatchesTotal = new client.Counter({
  name: 'client_rum_batches_total',
  help: 'Accepted browser RUM report batches (ENABLE_CLIENT_RUM)',
});

// ── Overload stage ───────────────────────────────────────────────────────────

/**
 * Current overload stage (0–3).  Set by overload.ts on every getStage() call
 * so Grafana can alert on stage transitions without relying on log scraping.
 */
const overloadStageGauge = new client.Gauge({
  name: 'chatapp_overload_stage',
  help: 'Current load-shedding stage (0=normal 1=throttle-presence 2=shed-search 3=shed-writes)',
});

/** Call once after pool is created to start sampling every 500ms */
function startPgPoolMetrics(pool) {
  const logger = require('./logger');
  const circuitMax = parseInt(process.env.POOL_CIRCUIT_BREAKER_QUEUE || '32', 10);
  const highWatermark = Math.max(8, Math.floor(circuitMax * 0.25));
  let queueElevatedLogged = false;

  setInterval(() => {
    const waiting = pool.waitingCount;
    pgPoolTotal.set(pool.totalCount);
    pgPoolIdle.set(pool.idleCount);
    pgPoolWaiting.set(waiting);

    if (waiting >= highWatermark) {
      if (!queueElevatedLogged) {
        queueElevatedLogged = true;
        logger.warn(
          {
            poolWaiting: waiting,
            highWatermark,
            circuitMax,
            port: process.env.PORT,
            msg: 'pg pool checkout queue elevated — correlate with pg_pool_operation_errors_total and PgBouncer SHOW POOLS',
          },
          'pg_pool_queue_elevated',
        );
      }
    } else if (waiting <= Math.max(1, Math.floor(highWatermark / 2))) {
      queueElevatedLogged = false;
    }
  }, 500).unref();
}

/**
 * prom-client omits labeled counters from /metrics until the first observation.
 * Prime 0 increments so Prometheus/Grafana always have these series (flat 0 until real events).
 */
(function primeSparseLabeledCounters() {
  try {
    wsBackpressureEventsTotal.inc({ action: 'drop' }, 0);
    wsBackpressureEventsTotal.inc({ action: 'kill' }, 0);
    wsOutboundQueueDepthHistogram.observe({ priority: 'message' }, 0);
    wsOutboundQueueDepthHistogram.observe({ priority: 'best_effort' }, 0);
    wsOutboundQueuedFramesGauge.set(0);
    wsOutboundQueueBlockWaitsTotal.inc(0);
    wsOutboundQueueDroppedBestEffortTotal.inc(0);
    wsOutboundDrainBatchesTotal.inc(0);
    wsDisconnectsTotal.inc({ code: '1000', clean: 'true', bootstrap_ready: 'true' }, 0);
    wsDisconnectsTotal.inc({ code: '1006', clean: 'false', bootstrap_ready: 'false' }, 0);
    wsConnectionLifetimeMs.observe({ close_code: '1000', bootstrap_ready: 'true' }, 0);
    wsReconnectsTotal.inc({ window: 'le_5s' }, 0);
    wsReconnectsTotal.inc({ window: 'le_30s' }, 0);
    wsReconnectsTotal.inc({ window: 'le_120s' }, 0);
    wsReconnectGapMs.observe(0);
    wsReplayQueryTotal.inc({ result: 'ok' }, 0);
    wsReplayQueryTotal.inc({ result: 'skipped' }, 0);
    wsReplayQueryTotal.inc({ result: 'timeout' }, 0);
    wsReplayQueryTotal.inc({ result: 'pool_busy' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'ok' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'timeout' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'pool_busy' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'channel' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'conversation' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'user' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'community' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'unknown' }, 0);
    messageLastMessageRepointFkRetryTotal.inc({ scope: 'channel' }, 0);
    messageLastMessageRepointFkRetryTotal.inc({ scope: 'conversation' }, 0);
    messageCacheBustFailuresTotal.inc({ target: 'channel' }, 0);
    messageCacheBustFailuresTotal.inc({ target: 'conversation' }, 0);
    messagePostAccessDeniedTotal.inc({ reason: 'channel_access' }, 0);
    messagePostAccessDeniedTotal.inc({ reason: 'conversation_participant' }, 0);
    messagePostIdempotencyPollTotal.inc({ outcome: 'replay_201' }, 0);
    messagePostIdempotencyPollTotal.inc({ outcome: 'exhausted_409' }, 0);
    messagePostIdempotencyPollWaitMs.observe({ outcome: 'replay_201' }, 0);
    messagePostIdempotencyPollWaitMs.observe({ outcome: 'exhausted_409' }, 0);
    messageIngestStreamAppendedTotal.inc({ result: 'ok' }, 0);
    messageIngestStreamAppendedTotal.inc({ result: 'error' }, 0);
    messageIngestStreamConsumedTotal.inc({ result: 'ack' }, 0);
    httpRequestsAbortedTotal.inc({ method: 'GET', route: '/api/v1/messages' }, 0);
    httpRequestsAbortedTotal.inc({ method: 'POST', route: '/api/v1/messages' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'acquire_timeout' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'connection' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'shutdown' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'other' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'communities', result: 'hit' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'communities', result: 'miss' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'communities', result: 'coalesced' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'channels', result: 'hit' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'channels', result: 'miss' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'channels', result: 'coalesced' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_channel', result: 'hit' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_channel', result: 'miss' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_channel', result: 'coalesced' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_conversation', result: 'hit' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_conversation', result: 'miss' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'messages_conversation', result: 'coalesced' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'conversations', result: 'hit' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'conversations', result: 'miss' }, 0);
    endpointListCacheTotal.inc({ endpoint: 'conversations', result: 'coalesced' }, 0);
    endpointListCacheBypassTotal.inc({ endpoint: 'messages_channel', reason: 'pagination' }, 0);
    endpointListCacheBypassTotal.inc({ endpoint: 'messages_conversation', reason: 'pagination' }, 0);
    endpointListCacheInvalidationsTotal.inc({ endpoint: 'messages_channel', reason: 'write' }, 0);
    endpointListCacheInvalidationsTotal.inc({ endpoint: 'messages_conversation', reason: 'write' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'hit' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'miss' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'coalesced' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'hit' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'miss' }, 0);
    fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'coalesced' }, 0);
    conversationFanoutTargetsCacheVersionRetryTotal.inc({ outcome: 'retry' }, 0);
    conversationFanoutTargetsCacheVersionRetryTotal.inc({ outcome: 'uncached_return' }, 0);
    fanoutPublishDurationMs.observe({ path: 'channel_message', stage: 'channel_topic' }, 0);
    fanoutPublishDurationMs.observe({ path: 'channel_message', stage: 'total' }, 0);
    fanoutPublishDurationMs.observe({ path: 'channel_message_user_topics', stage: 'target_lookup' }, 0);
    fanoutPublishDurationMs.observe({ path: 'channel_message_user_topics', stage: 'publish' }, 0);
    fanoutPublishDurationMs.observe({ path: 'channel_message_user_topics', stage: 'total' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_event', stage: 'target_lookup' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_event', stage: 'publish' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_event', stage: 'total' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'target_lookup' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'wrap_payload' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'publish_passthrough_wall' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'publish_userfeed_wall' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'publish_parallel_wall' }, 0);
    fanoutPublishDurationMs.observe({ path: 'conversation_dm', stage: 'total' }, 0);
    fanoutPublishTargetsHistogram.observe({ path: 'channel_message_user_topics' }, 0);
    fanoutPublishTargetsHistogram.observe({ path: 'conversation_event' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'hit' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'miss' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'coalesced' }, 0);
    wsBootstrapChannelsHistogram.observe(0);
    pgQueriesPerRequestHistogram.observe({ route: '/api/v1/messages' }, 0);
    pgQueriesPerRequestHistogram.observe({ route: '/api/v1/communities' }, 0);
    pgBusinessSqlQueriesPerRequestHistogram.observe({ route: '/api/v1/messages' }, 0);
    pgBusinessSqlQueriesPerRequestHistogram.observe({ route: '/api/v1/communities' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'rum' }, 0);
    clientRumBatchesTotal.inc(0);
    clientWebVitalTimingSeconds.observe({ name: 'LCP' }, 0);
    clientWebVitalClsScore.observe({ name: 'CLS' }, 0);
    authBcryptQueueRejectsTotal.inc({ reason: 'saturated' }, 0);
    authBcryptQueueRejectsTotal.inc({ reason: 'timeout' }, 0);
  } catch {
    /* ignore during unusual test setups */
  }
})();

module.exports = {
  register: client.register,
  httpRequestsTotal,
  httpRequestDurationMs,
  httpRequestsAbortedTotal,
  httpOverloadShedTotal,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
  sideEffectQueueDepth,
  sideEffectQueueActiveWorkers,
  sideEffectQueueDelayMs,
  sideEffectJobDurationMs,
  sideEffectQueueDroppedTotal,
  overloadStageGauge,
  authBcryptDurationMs,
  authBcryptActive,
  authBcryptWaiters,
  authBcryptQueueRejectsTotal,
  authRateLimitHitsTotal,
  messagePostAccessDeniedTotal,
  messageIngestStreamAppendedTotal,
  messageIngestStreamConsumedTotal,
  messagePostResponseTotal,
  messagePostIdempotencyPollTotal,
  messagePostIdempotencyPollWaitMs,
  wsConnectionResultTotal,
  wsBackpressureEventsTotal,
  wsOutboundQueueDepthHistogram,
  wsOutboundQueuedFramesGauge,
  wsOutboundQueueBlockWaitsTotal,
  wsOutboundQueueDroppedBestEffortTotal,
  wsOutboundDrainBatchesTotal,
  wsDisconnectsTotal,
  wsConnectionLifetimeMs,
  wsReconnectsTotal,
  wsReconnectGapMs,
  wsReplayQueryTotal,
  wsReplayQueryDurationMs,
  redisFanoutPublishFailuresTotal,
  messageLastMessageRepointFkRetryTotal,
  wsBootstrapWallDurationMs,
  fanoutTargetCacheTotal,
  conversationFanoutTargetsCacheVersionRetryTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  messageCacheBustFailuresTotal,
  startPgPoolMetrics,
  pgPoolCircuitBreakerRejectsTotal,
  pgPoolOperationErrorsTotal,
  pgQueriesPerRequestHistogram,
  pgBusinessSqlQueriesPerRequestHistogram,
  endpointListCacheTotal,
  endpointListCacheBypassTotal,
  endpointListCacheInvalidationsTotal,
  apiRateLimitHitsTotal,
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
};
