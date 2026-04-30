
const client = require('prom-client');

client.register.setDefaultLabels({
  service: 'chatapp-api',
  env: process.env.NODE_ENV || 'development',
});

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics();

const {
  httpRequestsTotal,
  httpRequestDurationMs,
  httpRequestsAbortedTotal,
  httpOverloadShedTotal,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
} = require('./metrics/httpPresence');

const {
  sideEffectQueueDepth,
  sideEffectQueueActiveWorkers,
  sideEffectQueueDelayMs,
  sideEffectJobDurationMs,
  sideEffectQueueDroppedTotal,
  authBcryptDurationMs,
  authBcryptActive,
  authBcryptWaiters,
  authBcryptQueueRejectsTotal,
  authRateLimitHitsTotal,
} = require('./metrics/sideEffectAndAuth');
const {
  searchReplicaRetryTotal,
  searchResultsReturnedHistogram,
  searchThrottledTotal,
  searchQueryDurationMs,
  channelAccessCacheTotal,
  wsBootstrapChannelsHistogram,
  messageCacheBustFailuresTotal,
} = require('./metrics/searchPerformance');
const {
  pgPoolTotal,
  pgPoolIdle,
  pgPoolWaiting,
  pgQueriesTotal,
  pgPoolCircuitBreakerRejectsTotal,
  pgQueryGateActive,
  pgQueryGateWaiting,
  pgQueryGateRejectsTotal,
  pgPoolOperationErrorsTotal,
  pgQueriesPerRequestHistogram,
  pgBusinessSqlQueriesPerRequestHistogram,
  endpointListCacheTotal,
  endpointListCacheBypassTotal,
  endpointListCacheInvalidationsTotal,
  messagesListAccessCacheHitTotal,
  apiRateLimitHitsTotal,
  startPgPoolMetrics,
} = require('./metrics/pgPoolAndEndpointCache');
const {
  communityCountRedisUpdateTotal,
  communityCountPgReconcileTotal,
  communityCountPgReconcileSkippedTotal,
  communityCountCacheTotal,
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
} = require('./metrics/communityAndRum');
const {
  wsConnectionResultTotal,
  wsUpgradeSeenTotal,
  wsUpgradeRateLimitedTotal,
  wsReplayFailOpenTotal,
  wsReplayStartedTotal,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  abuseBlockedSubnetTotal,
  abuseAutoBanBlocksTotal,
  abuseAutoBanIssuedTotal,
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
  wsReplayDedupedTotal,
  wsReplayCachedTotal,
  wsReplayDbQueryTotal,
  wsReplayQueryTotal,
  wsReplayErrorClassTotal,
  wsReplayQueryDurationMs,
  wsPendingReplayUserTrimmedTotal,
  wsPendingUserZsetSize,
  wsPendingReplayGuardTotal,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
  channelMessageFanoutRecipientTotal,
  realtimeMissAttributionTotal,
  pendingReplayRecipientTotal,
  pendingReplayEntriesPerMessage,
  pendingReplaySecondProbeRecentUserTotal,
  offlinePendingSkippedTotal,
  redisFanoutPublishFailuresTotal,
  messageLastMessageRepointFkRetryTotal,
  channelLastMessageUpdateDeferredTotal,
  channelLastMessageUpdateFlushedTotal,
  channelLastMessageUpdateFailedTotal,
  lastMessageRedisUpdateTotal,
  lastMessagePgReconcileTotal,
  lastMessagePgReconcileSkippedTotal,
  lastMessageCacheTotal,
  wsBootstrapWallDurationMs,
  fanoutTargetCacheTotal,
  conversationFanoutTargetsCacheVersionRetryTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  fanoutTargetCandidatesHistogram,
  fanoutRecentConnectCacheTotal,
  fanoutRecentConnectZsetSize,
  wsBootstrapListCacheTotal,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
} = require('./metrics/wsRuntimeAndDelivery');

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

/** POST /messages: Postgres succeeded but Redis pub/sub fanout threw (client still gets 201 + complete:false). */
const messagePostRealtimePublishFailTotal = new client.Counter({
  name: 'message_post_realtime_publish_fail_total',
  help: 'POST /messages realtime fanout failed after DB commit (Redis publish exhausted retries or lookup error)',
  labelNames: ['target'],
});

/** POST /messages async fanout: enqueue outcome (queued vs critical queue full fallback). */
const messagePostFanoutAsyncEnqueueTotal = new client.Counter({
  name: 'message_post_fanout_async_enqueue_total',
  help: 'POST /messages deferred fanout enqueue by path and result',
  labelNames: ['path', 'result'],
});

/** Deferred POST /messages fanout job terminal outcomes (after dedupe lock acquired). */
const messagePostFanoutJobTotal = new client.Counter({
  name: 'message_post_fanout_job_total',
  help: 'Deferred POST /messages fanout job outcomes',
  labelNames: ['path', 'result'],
});

const messagePostFanoutJobRetriesTotal = new client.Counter({
  name: 'message_post_fanout_job_retries_total',
  help: 'Deferred POST /messages fanout publish retries after transient failure',
  labelNames: ['path'],
});

const messagePostFanoutJobDurationMs = new client.Histogram({
  name: 'message_post_fanout_job_duration_ms',
  help: 'Wall-clock duration of deferred POST /messages fanout job',
  labelNames: ['path', 'result'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

/** POST message fanout job wall time (success / dead_letter / error); SLO alerts use p99 on `result=success`. */
const fanoutJobLatencyMs = new client.Histogram({
  name: 'fanout_job_latency_ms',
  help: 'Deferred POST /messages fanout job wall-clock latency',
  labelNames: ['path', 'result'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

/** Fanout side-effect queue depth (mirrors fanout:* segment of side_effect_queue_depth). */
const fanoutQueueDepth = new client.Gauge({
  name: 'fanout_queue_depth',
  help: 'Pending jobs on fanout side-effect queues',
  labelNames: ['queue'],
});

const fanoutRetryTotal = new client.Counter({
  name: 'fanout_retry_total',
  help: 'Retries inside deferred POST /messages fanout job after publish failure',
  labelNames: ['path'],
});

/** Redis Lua SCRIPT LOAD / EVALSHA behavior for registered scripts. */
const redisLuaScriptLoadTotal = new client.Counter({
  name: 'redis_lua_script_load_total',
  help: 'Redis Lua script load outcomes by script id',
  labelNames: ['script_id', 'result'],
});

const redisLuaEvalTotal = new client.Counter({
  name: 'redis_lua_eval_total',
  help: 'Redis Lua eval outcomes by script id and mode',
  labelNames: ['script_id', 'mode', 'result'],
});

const redisLuaNoScriptRetryTotal = new client.Counter({
  name: 'redis_lua_noscript_retry_total',
  help: 'Redis Lua NOSCRIPT retries by script id',
  labelNames: ['script_id'],
});

/**
 * Post-insert work hit a wall-clock budget (cache bust or legacy timed publish).
 * Informational only — HTTP 201 still returned when the message row is committed.
 */
const deliveryTimeoutTotal = new client.Counter({
  name: 'delivery_timeout_total',
  help: 'Post-insert delivery-path wall-clock timeouts (does not imply HTTP failure)',
  labelNames: ['phase'],
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

/** POST /messages rejected by Redis-backed per-user / per-IP rate limits. */
const messagePostRateLimitHitsTotal = new client.Counter({
  name: 'message_post_rate_limit_hits_total',
  help: 'POST /api/v1/messages requests rejected by message-post rate limiters',
  labelNames: ['scope'],
});

/** POST /messages channel-only cross-worker insert lock outcomes. */
const messageChannelInsertLockTotal = new client.Counter({
  name: 'message_channel_insert_lock_total',
  help: 'Cross-worker Redis lease outcomes for channel-scoped POST /messages inserts',
  labelNames: ['result'],
});

/**
 * Per-request insert path for channel POST /messages (orthogonal to message_channel_insert_lock_total).
 * path: optimistic_bypass | acquired_immediate | acquired_after_wait | redis_fallback_null_lease
 * reason_detail: env_optimistic | env_mode_off | env_lock_disabled | none | redis_set_error
 */
const messageChannelInsertPathTotal = new client.Counter({
  name: 'message_channel_insert_path_total',
  help: 'POST /messages channel insert path decision (bypass vs serialized acquire vs Redis fallback)',
  labelNames: ['path', 'reason_detail'],
});

/** Milliseconds from POST insert-path entry to DB txn start (queue + Redis spin; 0 for optimistic bypass). */
const messageChannelInsertPathPrecallMs = new client.Histogram({
  name: 'message_channel_insert_path_precall_ms',
  help: 'Time spent before channel insert DB work, by insert path',
  labelNames: ['path'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

const messageChannelInsertLockWaitMs = new client.Histogram({
  name: 'message_channel_insert_lock_wait_ms',
  help: 'Milliseconds spent waiting on the channel-scoped POST /messages insert lock',
  labelNames: ['result'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Current number of in-process POST /messages lock waiters across channels. */
const messageInsertLockWaitersCurrentGauge = new client.Gauge({
  name: 'message_insert_lock_waiters_current',
  help: 'Current number of in-process channel insert lock waiters',
});

/** Requests rejected early because per-channel lock waiter cap was reached. */
const messageInsertLockQueueRejectTotal = new client.Counter({
  name: 'message_insert_lock_queue_reject_total',
  help: 'POST /messages rejects when channel insert lock waiter cap is exceeded',
  labelNames: ['reason'],
});

/** Number of channel insert lock wait timeout events. */
const messageInsertLockWaitTimeoutTotal = new client.Counter({
  name: 'message_insert_lock_wait_timeout_total',
  help: 'POST /messages lock wait timeout events',
});

/** Successful lock acquires that had to wait at least one poll interval. */
const messageInsertLockAcquiredAfterWaitTotal = new client.Counter({
  name: 'message_insert_lock_acquired_after_wait_total',
  help: 'POST /messages lock acquires after non-zero waiting time',
});

/** Time spent holding the channel insert lease (acquire -> release attempt). */
const messageInsertLockHolderDurationMs = new client.Histogram({
  name: 'message_insert_lock_holder_duration_ms',
  help: 'Milliseconds spent holding the channel-scoped POST /messages insert lock',
  labelNames: ['result'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** PUT /messages/:id/read early soft-defer events by reason. */
const readReceiptShedTotal = new client.Counter({
  name: 'read_receipt_shed_total',
  help: 'PUT /messages/:id/read requests soft-deferred before handler work, by reason',
  labelNames: ['reason'],
});

/** PUT /messages/:id/read labeled outcomes (sparse priming for deferred paths). */
const readReceiptRequestsTotal = new client.Counter({
  name: 'read_receipt_requests_total',
  help: 'PUT /messages/:id/read outcomes by result label',
  labelNames: ['result'],
});

/** Distribution of Redis CAS outcomes for read cursor advance, by scope. */
const readReceiptCursorCasTotal = new client.Counter({
  name: 'read_receipt_cursor_cas_total',
  help: 'Redis CAS result distribution for PUT /messages/:id/read by scope',
  labelNames: ['scope', 'cas_result'],
});

/** Split of read requests by target scope. */
const readReceiptScopeTotal = new client.Counter({
  name: 'read_receipt_scope_total',
  help: 'PUT /messages/:id/read requests by scope',
  labelNames: ['scope'],
});

/** Read-path optimizations applied on the hot path. */
const readReceiptOptimizationTotal = new client.Counter({
  name: 'read_receipt_optimization_total',
  help: 'PUT /messages/:id/read optimization events by reason',
  labelNames: ['reason'],
});

/** PUT /messages/:id/read skipped because cursor already at/ahead of target message. */
const readReceiptNoopSkipTotal = new client.Counter({
  name: 'read_receipt_noop_skip_total',
  help: 'PUT /messages/:id/read requests that performed no state change and skipped side effects',
  labelNames: ['reason'],
});

/** PUT /messages/:id/read coalesced bursts (same message or same cursor scope cooldown). */
const readReceiptCoalescedTotal = new client.Counter({
  name: 'read_receipt_coalesced_total',
  help: 'PUT /messages/:id/read requests coalesced to avoid duplicate work',
  labelNames: ['reason'],
});

/** GET /unread-counts requests shed before DB work under pressure safeguards. */
const unreadCountsShedTotal = new client.Counter({
  name: 'unread_counts_shed_total',
  help: 'GET /api/v1/unread-counts requests shed before DB work due to pressure safeguards',
  labelNames: ['reason'],
});

/** GET /unread-counts requests reused an in-flight per-user computation. */
const unreadCountsCoalescedTotal = new client.Counter({
  name: 'unread_counts_coalesced_total',
  help: 'GET /api/v1/unread-counts requests reused an in-flight response for the same user',
});

/** PUT /messages/:id/read DB upsert path outcome after Redis cursor CAS. */
const readReceiptDbUpsertTotal = new client.Counter({
  name: 'read_receipt_db_upsert_total',
  help: 'PUT /messages/:id/read DB upsert enqueue/skip outcomes after Redis CAS',
  labelNames: ['result'],
});

/** PUT /messages/:id/read in-process cursor cache outcomes (short TTL). */
const readReceiptCursorCacheHitTotal = new client.Counter({
  name: 'read_receipt_cursor_cache_hit_total',
  help: 'PUT /messages/:id/read in-process cursor cache outcomes by result',
  labelNames: ['result'],
});

/** Rolling-window p95 insert-lock wait (ms) on this worker; updated when evaluating read shed. */
const messageChannelInsertLockPressureWaitP95MsGauge = new client.Gauge({
  name: 'message_channel_insert_lock_pressure_wait_p95_ms',
  help: 'Rolling-window p95 wait for successful channel insert lock acquires (read shed signal)',
});

/** Count of insert-lock timeouts in the rolling pressure window on this worker. */
const messageChannelInsertLockPressureRecentTimeoutsGauge = new client.Gauge({
  name: 'message_channel_insert_lock_pressure_recent_timeout_count',
  help: 'Channel insert lock timeouts in the rolling MESSAGE_INSERT_LOCK_PRESSURE_WINDOW_MS window',
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
    wsReplayDedupedTotal.inc(0);
    wsReplayCachedTotal.inc(0);
    wsReplayDbQueryTotal.inc(0);
    wsReplayQueryTotal.inc({ result: 'ok' }, 0);
    wsReplayQueryTotal.inc({ result: 'skipped' }, 0);
    wsReplayQueryTotal.inc({ result: 'timeout' }, 0);
    wsReplayQueryTotal.inc({ result: 'pool_busy' }, 0);
    wsReplayErrorClassTotal.inc({ error_class: 'timeout' }, 0);
    wsReplayErrorClassTotal.inc({ error_class: 'pool_busy' }, 0);
    wsReplayErrorClassTotal.inc({ error_class: 'error' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'ok' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'skipped' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'timeout' }, 0);
    wsReplayQueryDurationMs.observe({ result: 'pool_busy' }, 0);
    wsPendingReplayUserTrimmedTotal.inc(0);
    wsPendingUserZsetSize.observe(0);
    wsPendingReplayGuardTotal.inc({ reason: 'redis_memory_high' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'channel' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'conversation' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'user' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'community' }, 0);
    redisFanoutPublishFailuresTotal.inc({ channel_prefix: 'unknown' }, 0);
    messageLastMessageRepointFkRetryTotal.inc({ scope: 'channel' }, 0);
    messageLastMessageRepointFkRetryTotal.inc({ scope: 'conversation' }, 0);
    channelLastMessageUpdateDeferredTotal.inc({ target: 'channel' }, 0);
    channelLastMessageUpdateDeferredTotal.inc({ target: 'conversation' }, 0);
    channelLastMessageUpdateFlushedTotal.inc({ target: 'channel' }, 0);
    channelLastMessageUpdateFlushedTotal.inc({ target: 'conversation' }, 0);
    channelLastMessageUpdateFailedTotal.inc({ target: 'channel' }, 0);
    channelLastMessageUpdateFailedTotal.inc({ target: 'conversation' }, 0);
    lastMessageRedisUpdateTotal.inc({ target: 'channel', result: 'ok' }, 0);
    lastMessageRedisUpdateTotal.inc({ target: 'channel', result: 'error' }, 0);
    lastMessageRedisUpdateTotal.inc({ target: 'conversation', result: 'ok' }, 0);
    lastMessageRedisUpdateTotal.inc({ target: 'conversation', result: 'error' }, 0);
    lastMessagePgReconcileTotal.inc({ target: 'channel', result: 'ok' }, 0);
    lastMessagePgReconcileTotal.inc({ target: 'channel', result: 'error' }, 0);
    lastMessagePgReconcileTotal.inc({ target: 'conversation', result: 'ok' }, 0);
    lastMessagePgReconcileTotal.inc({ target: 'conversation', result: 'error' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'channel_disabled' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'channel_pressure' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'insert_lock_pressure' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'conversation_disabled' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'channel_repoint_disabled' }, 0);
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'conversation_repoint_disabled' }, 0);
    lastMessageCacheTotal.inc({ target: 'channel', result: 'hit' }, 0);
    lastMessageCacheTotal.inc({ target: 'channel', result: 'miss' }, 0);
    lastMessageCacheTotal.inc({ target: 'channel', result: 'error' }, 0);
    lastMessageCacheTotal.inc({ target: 'conversation', result: 'hit' }, 0);
    lastMessageCacheTotal.inc({ target: 'conversation', result: 'miss' }, 0);
    lastMessageCacheTotal.inc({ target: 'conversation', result: 'error' }, 0);
    lastMessageCacheTotal.inc({ target: 'community_channel', result: 'hit' }, 0);
    lastMessageCacheTotal.inc({ target: 'community_channel', result: 'miss' }, 0);
    lastMessageCacheTotal.inc({ target: 'community_channel', result: 'error' }, 0);
    messageCacheBustFailuresTotal.inc({ target: 'channel' }, 0);
    messageCacheBustFailuresTotal.inc({ target: 'conversation' }, 0);
    messagePostAccessDeniedTotal.inc({ reason: 'channel_access' }, 0);
    messagePostAccessDeniedTotal.inc({ reason: 'conversation_participant' }, 0);
    messagePostRealtimePublishFailTotal.inc({ target: 'channel' }, 0);
    messagePostRealtimePublishFailTotal.inc({ target: 'conversation' }, 0);
    for (const path of ['channel', 'conversation'] as const) {
      for (const result of ['queued', 'queue_full', 'sync'] as const) {
        messagePostFanoutAsyncEnqueueTotal.inc({ path, result }, 0);
      }
      for (const result of ['success', 'dedup_skip', 'dead_letter', 'error'] as const) {
        messagePostFanoutJobTotal.inc({ path, result }, 0);
        messagePostFanoutJobDurationMs.observe({ path, result }, 0);
        fanoutJobLatencyMs.observe({ path, result }, 0);
      }
      messagePostFanoutJobRetriesTotal.inc({ path }, 0);
      fanoutRetryTotal.inc({ path }, 0);
    }
    deliveryTimeoutTotal.inc({ phase: 'cache_bust' }, 0);
    fanoutQueueDepth.set({ queue: 'fanout:critical' }, 0);
    fanoutQueueDepth.set({ queue: 'fanout:background' }, 0);
    fanoutQueueDepth.set({ queue: 'fanout:all' }, 0);
    messagePostIdempotencyPollTotal.inc({ outcome: 'replay_201' }, 0);
    messagePostIdempotencyPollTotal.inc({ outcome: 'exhausted_409' }, 0);
    messagePostIdempotencyPollWaitMs.observe({ outcome: 'replay_201' }, 0);
    messagePostIdempotencyPollWaitMs.observe({ outcome: 'exhausted_409' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'acquired_immediate' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'acquired_after_wait' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'optimistic_bypass' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'timeout' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'redis_error' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'release_mismatch' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'release_error' }, 0);
    messageChannelInsertLockTotal.inc({ result: 'queue_reject' }, 0);
    messageChannelInsertLockWaitMs.observe({ result: 'acquired' }, 0);
    messageChannelInsertLockWaitMs.observe({ result: 'timeout' }, 0);
    messageChannelInsertLockWaitMs.observe({ result: 'redis_error' }, 0);
    for (const path of [
      'optimistic_bypass',
      'acquired_immediate',
      'acquired_after_wait',
      'redis_fallback_null_lease',
    ]) {
      for (const reason_detail of [
        'env_optimistic',
        'env_mode_off',
        'env_lock_disabled',
        'none',
        'redis_set_error',
      ]) {
        messageChannelInsertPathTotal.inc({ path, reason_detail }, 0);
      }
      messageChannelInsertPathPrecallMs.observe({ path }, 0);
    }
    messageInsertLockWaitersCurrentGauge.set(0);
    messageInsertLockQueueRejectTotal.inc({ reason: 'per_channel_waiter_cap' }, 0);
    messageInsertLockWaitTimeoutTotal.inc(0);
    messageInsertLockAcquiredAfterWaitTotal.inc(0);
    messageInsertLockHolderDurationMs.observe({ result: 'released' }, 0);
    messageInsertLockHolderDurationMs.observe({ result: 'release_mismatch' }, 0);
    messageInsertLockHolderDurationMs.observe({ result: 'release_error' }, 0);
    messageInsertLockHolderDurationMs.observe({ result: 'no_lease' }, 0);
    readReceiptShedTotal.inc({ reason: 'message_channel_insert_lock_pressure' }, 0);
    readReceiptShedTotal.inc({ reason: 'overload_stage_high' }, 0);
    readReceiptRequestsTotal.inc(
      { result: 'deferred_message_channel_insert_lock_pressure' },
      0,
    );
    readReceiptRequestsTotal.inc({ result: 'deferred_overload_stage_high' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'channel', cas_result: '0' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'channel', cas_result: '1' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'channel', cas_result: '2' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'conversation', cas_result: '0' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'conversation', cas_result: '1' }, 0);
    readReceiptCursorCasTotal.inc({ scope: 'conversation', cas_result: '2' }, 0);
    readReceiptScopeTotal.inc({ scope: 'channel' }, 0);
    readReceiptScopeTotal.inc({ scope: 'conversation' }, 0);
    readReceiptOptimizationTotal.inc({ reason: 'cas1_side_effects_debounced' }, 0);
    readReceiptOptimizationTotal.inc({ reason: 'conversation_read_direct_user_fanout' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'cursor_not_advanced' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'same_message_coalesced' }, 0);
    unreadCountsShedTotal.inc({ reason: 'pool_waiting' }, 0);
    unreadCountsShedTotal.inc({ reason: 'inflight_cap' }, 0);
    unreadCountsCoalescedTotal.inc(0);
    readReceiptNoopSkipTotal.inc({ reason: 'scope_cursor_cache' }, 0);
    readReceiptCoalescedTotal.inc({ reason: 'same_message' }, 0);
    readReceiptCoalescedTotal.inc({ reason: 'scope_cursor' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'enqueued' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'rate_limited' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'noop' }, 0);
    readReceiptCursorCacheHitTotal.inc({ result: 'hit' }, 0);
    readReceiptCursorCacheHitTotal.inc({ result: 'miss' }, 0);
    messageChannelInsertLockPressureWaitP95MsGauge.set(0);
    messageChannelInsertLockPressureRecentTimeoutsGauge.set(0);
    messageIngestStreamAppendedTotal.inc({ result: 'ok' }, 0);
    messageIngestStreamAppendedTotal.inc({ result: 'error' }, 0);
    messageIngestStreamConsumedTotal.inc({ result: 'ack' }, 0);
    httpRequestsAbortedTotal.inc({ method: 'GET', route: '/api/v1/messages' }, 0);
    httpRequestsAbortedTotal.inc({ method: 'POST', route: '/api/v1/messages' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'acquire_timeout' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'connection' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'shutdown' }, 0);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason: 'other' }, 0);
    pgQueriesTotal.inc({ pool: 'primary' }, 0);
    pgQueriesTotal.inc({ pool: 'read' }, 0);
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
    messagesListAccessCacheHitTotal.inc({ path: 'channel_latest' }, 0);
    messagesListAccessCacheHitTotal.inc({ path: 'channel_paginated' }, 0);
    channelAccessCacheTotal.inc({ result: 'hit' }, 0);
    channelAccessCacheTotal.inc({ result: 'miss' }, 0);
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
    fanoutPublishTargetsHistogram.observe({ path: 'channel_message_recent_connect_user_topics' }, 0);
    fanoutPublishTargetsHistogram.observe({ path: 'conversation_event' }, 0);
    fanoutTargetCandidatesHistogram.observe({ path: 'channel_message_user_topics' }, 0);
    fanoutTargetCandidatesHistogram.observe({ path: 'channel_message_recent_connect_user_topics' }, 0);
    fanoutRecentConnectCacheTotal.inc({ result: 'hit' }, 0);
    fanoutRecentConnectCacheTotal.inc({ result: 'miss' }, 0);
    fanoutRecentConnectZsetSize.observe(0);
    wsBootstrapListCacheTotal.inc({ result: 'hit' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'miss' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'coalesced' }, 0);
    wsBootstrapBlockedTotal.inc({ reason: 'concurrency_cap' }, 0);
    wsBootstrapBlockedTotal.inc({ reason: 'concurrency_wait_timeout' }, 0);
    wsBootstrapCachedTotal.inc({ source: 'ttl' }, 0);
    wsBootstrapCachedTotal.inc({ source: 'inflight' }, 0);
    wsBootstrapDbTotal.inc(0);
    wsBootstrapChannelsHistogram.observe(0);
    pgQueriesPerRequestHistogram.observe({ route: '/api/v1/messages' }, 0);
    pgQueriesPerRequestHistogram.observe({ route: '/api/v1/communities' }, 0);
    pgBusinessSqlQueriesPerRequestHistogram.observe({ route: '/api/v1/messages' }, 0);
    pgBusinessSqlQueriesPerRequestHistogram.observe({ route: '/api/v1/communities' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'rum' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'community_join_ip' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'community_join_user' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'messages_inmem_user' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'messages_inmem_ip' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'search_inmem_user' }, 0);
    apiRateLimitHitsTotal.inc({ scope: 'search_inmem_ip' }, 0);
    wsUpgradeSeenTotal.inc(0);
    wsUpgradeRateLimitedTotal.inc(0);
    wsReplayFailOpenTotal.inc({ reason: 'disabled' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'pool_waiting' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'semaphore_full' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'per_ip' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'per_socket' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'global_concurrency' }, 0);
    wsReplayFailOpenTotal.inc({ reason: 'insert_lock_pressure' }, 0);
    wsReplayStartedTotal.inc(0);
    wsReliableDeliveryTotal.inc({ path: 'realtime', source: 'live_pubsub' }, 0);
    wsReliableDeliveryTotal.inc({ path: 'replay', source: 'missed_db' }, 0);
    wsReliableDeliveryTotal.inc({ path: 'replay', source: 'pending_queue' }, 0);
    wsReliableDeliveryLatencyMs.observe({ path: 'realtime' }, 0);
    wsReliableDeliveryLatencyMs.observe({ path: 'replay' }, 0);
    for (const path of ['realtime', 'replay'] as const) {
      for (const topic_prefix of ['channel', 'user', 'conversation', 'community', 'userfeed', 'other'] as const) {
        wsReliableDeliveryTopicTotal.inc({ path, topic_prefix }, 0);
      }
    }
    channelMessageFanoutRecipientTotal.inc({ segment: 'candidate' }, 0);
    channelMessageFanoutRecipientTotal.inc({ segment: 'inline_user_topic' }, 0);
    channelMessageFanoutRecipientTotal.inc({ segment: 'deferred_user_topic' }, 0);
    realtimeMissAttributionTotal.inc({ reason: 'channel_user_topic_deferred_not_recent' }, 0);
    realtimeMissAttributionTotal.inc({ reason: 'topic_message_send_blocked' }, 0);
    realtimeMissAttributionTotal.inc({ reason: 'topic_message_partial_delivery' }, 0);
    realtimeMissAttributionTotal.inc({ reason: 'channel_topic_stale_map_userfeed_recovery' }, 0);
    pendingReplayRecipientTotal.inc({ class: 'connected' }, 0);
    pendingReplayRecipientTotal.inc({ class: 'recent' }, 0);
    pendingReplayRecipientTotal.inc({ class: 'offline_skipped' }, 0);
    pendingReplayRecipientTotal.inc({ class: 'legacy_enqueue' }, 0);
    pendingReplayEntriesPerMessage.observe(0);
    offlinePendingSkippedTotal.inc(0);
    pendingReplaySecondProbeRecentUserTotal.inc({ mode: 'conversation_marker' }, 0);
    pendingReplaySecondProbeRecentUserTotal.inc({ mode: 'legacy_global' }, 0);
    // Do not zero chatapp_ws_replay_* gauges here: server.ts sets semaphore cap/inflight
    // on load; forcing cap=0 made alerts using clamp_min(cap,1) false-positive (inflight>1).
    abuseBlockedSubnetTotal.inc(0);
    abuseAutoBanBlocksTotal.inc(0);
    abuseAutoBanIssuedTotal.inc(0);
    clientRumBatchesTotal.inc(0);
    clientWebVitalTimingSeconds.observe({ name: 'LCP' }, 0);
    clientWebVitalClsScore.observe({ name: 'CLS' }, 0);
    authBcryptQueueRejectsTotal.inc({ reason: 'saturated' }, 0);
    authBcryptQueueRejectsTotal.inc({ reason: 'timeout' }, 0);
    communityCountRedisUpdateTotal.inc({ result: 'ok' }, 0);
    communityCountRedisUpdateTotal.inc({ result: 'error' }, 0);
    communityCountPgReconcileTotal.inc({ result: 'ok' }, 0);
    communityCountPgReconcileTotal.inc({ result: 'error' }, 0);
    communityCountPgReconcileSkippedTotal.inc({ reason: 'lock' }, 0);
    communityCountPgReconcileSkippedTotal.inc({ reason: 'pressure' }, 0);
    communityCountPgReconcileSkippedTotal.inc({ reason: 'insert_lock_pressure' }, 0);
    communityCountPgReconcileSkippedTotal.inc({ reason: 'empty' }, 0);
    communityCountCacheTotal.inc({ result: 'hit' }, 0);
    communityCountCacheTotal.inc({ result: 'miss' }, 0);
    for (const script_id of [
      'read_receipt_cursor_advance',
      'read_receipt_reset_unread_watermark',
      'lock_release_if_match',
      'presence_db_cas',
    ] as const) {
      redisLuaScriptLoadTotal.inc({ script_id, result: 'ok' }, 0);
      redisLuaScriptLoadTotal.inc({ script_id, result: 'error' }, 0);
      redisLuaEvalTotal.inc({ script_id, mode: 'evalsha', result: 'ok' }, 0);
      redisLuaEvalTotal.inc({ script_id, mode: 'evalsha', result: 'error' }, 0);
      redisLuaEvalTotal.inc({ script_id, mode: 'eval_fallback', result: 'ok' }, 0);
      redisLuaEvalTotal.inc({ script_id, mode: 'eval_fallback', result: 'error' }, 0);
      redisLuaNoScriptRetryTotal.inc({ script_id }, 0);
    }
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
  messagePostRealtimePublishFailTotal,
  messagePostFanoutAsyncEnqueueTotal,
  messagePostFanoutJobTotal,
  messagePostFanoutJobRetriesTotal,
  messagePostFanoutJobDurationMs,
  fanoutJobLatencyMs,
  fanoutQueueDepth,
  fanoutRetryTotal,
  redisLuaScriptLoadTotal,
  redisLuaEvalTotal,
  redisLuaNoScriptRetryTotal,
  deliveryTimeoutTotal,
  messagePostIdempotencyPollTotal,
  messagePostIdempotencyPollWaitMs,
  messagePostRateLimitHitsTotal,
  messageChannelInsertLockTotal,
  messageChannelInsertPathTotal,
  messageChannelInsertPathPrecallMs,
  messageChannelInsertLockWaitMs,
  messageInsertLockWaitersCurrentGauge,
  messageInsertLockQueueRejectTotal,
  messageInsertLockWaitTimeoutTotal,
  messageInsertLockAcquiredAfterWaitTotal,
  messageInsertLockHolderDurationMs,
  readReceiptShedTotal,
  readReceiptRequestsTotal,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
  readReceiptNoopSkipTotal,
  readReceiptCoalescedTotal,
  unreadCountsShedTotal,
  unreadCountsCoalescedTotal,
  readReceiptDbUpsertTotal,
  readReceiptCursorCacheHitTotal,
  messageChannelInsertLockPressureWaitP95MsGauge,
  messageChannelInsertLockPressureRecentTimeoutsGauge,
  wsConnectionResultTotal,
  wsBackpressureEventsTotal,
  channelAccessCacheTotal,
  wsOutboundQueueDepthHistogram,
  wsOutboundQueuedFramesGauge,
  wsOutboundQueueBlockWaitsTotal,
  wsOutboundQueueDroppedBestEffortTotal,
  wsOutboundDrainBatchesTotal,
  wsDisconnectsTotal,
  wsConnectionLifetimeMs,
  wsReconnectsTotal,
  wsReconnectGapMs,
  wsReplayDedupedTotal,
  wsReplayCachedTotal,
  wsReplayDbQueryTotal,
  wsReplayQueryTotal,
  wsReplayErrorClassTotal,
  wsReplayQueryDurationMs,
  wsPendingReplayUserTrimmedTotal,
  wsPendingUserZsetSize,
  wsPendingReplayGuardTotal,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
  channelMessageFanoutRecipientTotal,
  realtimeMissAttributionTotal,
  pendingReplayRecipientTotal,
  pendingReplayEntriesPerMessage,
  pendingReplaySecondProbeRecentUserTotal,
  offlinePendingSkippedTotal,
  redisFanoutPublishFailuresTotal,
  messageLastMessageRepointFkRetryTotal,
  channelLastMessageUpdateDeferredTotal,
  channelLastMessageUpdateFlushedTotal,
  channelLastMessageUpdateFailedTotal,
  lastMessageRedisUpdateTotal,
  lastMessagePgReconcileTotal,
  lastMessagePgReconcileSkippedTotal,
  lastMessageCacheTotal,
  wsBootstrapWallDurationMs,
  fanoutTargetCacheTotal,
  conversationFanoutTargetsCacheVersionRetryTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  fanoutTargetCandidatesHistogram,
  fanoutRecentConnectCacheTotal,
  fanoutRecentConnectZsetSize,
  wsBootstrapListCacheTotal,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapChannelsHistogram,
  messageCacheBustFailuresTotal,
  searchReplicaRetryTotal,
  searchResultsReturnedHistogram,
  searchThrottledTotal,
  searchQueryDurationMs,
  startPgPoolMetrics,
  pgPoolCircuitBreakerRejectsTotal,
  pgPoolOperationErrorsTotal,
  pgQueriesTotal,
  pgQueryGateActive,
  pgQueryGateWaiting,
  pgQueryGateRejectsTotal,
  pgQueriesPerRequestHistogram,
  pgBusinessSqlQueriesPerRequestHistogram,
  endpointListCacheTotal,
  endpointListCacheBypassTotal,
  endpointListCacheInvalidationsTotal,
  messagesListAccessCacheHitTotal,
  apiRateLimitHitsTotal,
  wsUpgradeSeenTotal,
  wsUpgradeRateLimitedTotal,
  wsReplayFailOpenTotal,
  wsReplayStartedTotal,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  abuseBlockedSubnetTotal,
  abuseAutoBanBlocksTotal,
  abuseAutoBanIssuedTotal,
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
  communityCountRedisUpdateTotal,
  communityCountPgReconcileTotal,
  communityCountPgReconcileSkippedTotal,
  communityCountCacheTotal,
};
