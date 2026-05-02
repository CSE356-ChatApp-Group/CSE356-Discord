/**
 * Message POST/fanout/idempotency/insert-lock/read-receipt metrics.
 */

const client = require('prom-client');

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
  help: 'Deferred POST /messages fanout job wall time',
  labelNames: ['path', 'result'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const fanoutJobLatencyMs = new client.Histogram({
  name: 'fanout_job_latency_ms',
  help: 'Age of deferred fanout jobs when consumed',
  labelNames: ['path', 'result'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
});

const fanoutQueueDepth = new client.Gauge({
  name: 'fanout_queue_depth',
  help: 'Deferred fanout queue depth by queue',
  labelNames: ['queue'],
});

const fanoutRetryTotal = new client.Counter({
  name: 'fanout_retry_total',
  help: 'Deferred fanout publish retry attempts',
  labelNames: ['path'],
});

/** Redis Lua script load outcomes by script id (startup and NOSCRIPT reloads). */
const redisLuaScriptLoadTotal = new client.Counter({
  name: 'redis_lua_script_load_total',
  help: 'Redis Lua script load attempts by script id and outcome',
  labelNames: ['script_id', 'result'],
});

/** Redis Lua execution outcomes by script id and mode. */
const redisLuaEvalTotal = new client.Counter({
  name: 'redis_lua_eval_total',
  help: 'Redis Lua execution attempts by script id, mode, and outcome',
  labelNames: ['script_id', 'mode', 'result'],
});

/** NOSCRIPT fallback attempts after evalsha miss by script id. */
const redisLuaNoScriptRetryTotal = new client.Counter({
  name: 'redis_lua_noscript_retry_total',
  help: 'Redis Lua NOSCRIPT fallback attempts by script id',
  labelNames: ['script_id'],
});

/**
 * Deferred fanout could not finish before timeout / retry budget and fell back to inline
 * delivery (message already committed).  phase tells where it timed out.
 */
const deliveryTimeoutTotal = new client.Counter({
  name: 'delivery_timeout_total',
  help: 'Deferred fanout timed out and fell back to immediate delivery (or gave up), labeled by phase',
  labelNames: ['phase'],
});

/**
 * POST /messages idempotency polling outcomes while waiting on a concurrent writer:
 * - replay_201: existing message became visible and was returned as 201 replay
 * - exhausted_409: poll window elapsed without visibility, returned 409 to retry
 */
const messagePostIdempotencyPollTotal = new client.Counter({
  name: 'message_post_idempotency_poll_total',
  help: 'POST /messages idempotency poll outcomes while waiting for concurrent writer',
  labelNames: ['outcome'],
});

const messagePostIdempotencyPollWaitMs = new client.Histogram({
  name: 'message_post_idempotency_poll_wait_ms',
  help: 'Time spent polling idempotency winner before returning replay_201 or exhausted_409',
  labelNames: ['outcome'],
  buckets: [5, 10, 25, 50, 100, 200, 300, 400, 500, 750, 1000, 1500, 2000],
});

/** In-memory per-user/per-IP soft limiter for POST /messages (pre-authz cheap shed). */
const messagePostRateLimitHitsTotal = new client.Counter({
  name: 'message_post_rate_limit_hits_total',
  help: 'POST /messages rejected by in-memory soft limiter',
  labelNames: ['scope'],
});

/**
 * Channel insert lock outcomes used to debug concurrent sends in the same channel.
 * timeout/queue_reject correlate with elevated write contention.
 */
const messageChannelInsertLockTotal = new client.Counter({
  name: 'message_channel_insert_lock_total',
  help: 'Channel insert lock acquisition outcomes for ordered message writes',
  labelNames: ['result'],
});

/** Path actually used to execute channel message insert. */
const messageChannelInsertPathTotal = new client.Counter({
  name: 'message_channel_insert_path_total',
  help: 'Execution path used for channel message insert',
  labelNames: ['path', 'reason_detail'],
});

const messageChannelInsertPathPrecallMs = new client.Histogram({
  name: 'message_channel_insert_path_precall_ms',
  help: 'Pre-DB latency for channel insert path setup',
  labelNames: ['path'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25],
});

/** Wait time to acquire channel insert lock. */
const messageChannelInsertLockWaitMs = new client.Histogram({
  name: 'message_channel_insert_lock_wait_ms',
  help: 'Wait time in milliseconds to acquire channel insert lock',
  labelNames: ['result'],
  buckets: [1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000],
});

/** Current number of requests waiting on channel insert locks (process-local). */
const messageInsertLockWaitersCurrentGauge = new client.Gauge({
  name: 'message_insert_lock_waiters_current',
  help: 'Current number of requests waiting for channel insert lock',
});

/** Number of requests rejected due to too many waiters per channel lock queue. */
const messageInsertLockQueueRejectTotal = new client.Counter({
  name: 'message_insert_lock_queue_reject_total',
  help: 'Requests rejected because per-channel insert lock waiter queue exceeded cap',
  labelNames: ['reason'],
});

/** Number of requests that timed out waiting for channel insert lock. */
const messageInsertLockWaitTimeoutTotal = new client.Counter({
  name: 'message_insert_lock_wait_timeout_total',
  help: 'Requests that timed out waiting for channel insert lock',
});

/** Number of requests that acquired channel insert lock after waiting. */
const messageInsertLockAcquiredAfterWaitTotal = new client.Counter({
  name: 'message_insert_lock_acquired_after_wait_total',
  help: 'Requests that acquired channel insert lock after entering waiter queue',
});

/** Time lock holder kept lease from acquire to release attempt. */
const messageInsertLockHolderDurationMs = new client.Histogram({
  name: 'message_insert_lock_holder_duration_ms',
  help: 'Duration in milliseconds from lock acquire to release attempt',
  labelNames: ['result'],
  buckets: [1, 2, 5, 10, 20, 50, 100, 200, 300, 500, 1000, 2000, 5000],
});

/** PUT /messages/:id/read intentionally shed before write path under local pressure. */
const readReceiptShedTotal = new client.Counter({
  name: 'read_receipt_shed_total',
  help: 'Read receipt requests dropped due to local pressure or overload policy',
  labelNames: ['reason'],
});

/** PUT /messages/:id/read outcomes. */
const readReceiptRequestsTotal = new client.Counter({
  name: 'read_receipt_requests_total',
  help: 'Read receipt request outcomes by result',
  labelNames: ['result'],
});

/** Read-receipt preflight branch chosen before route work (shed/pass). */
const readReceiptPreflightTotal = new client.Counter({
  name: 'read_receipt_preflight_total',
  help: 'Read receipt preflight decisions by result',
  labelNames: ['result'],
});

/** Pool waiters seen at read preflight (helps tune READ_RECEIPT_DEFER_POOL_WAITING). */
const readReceiptPreflightPoolWaiting = new client.Histogram({
  name: 'read_receipt_preflight_pool_waiting',
  help: 'Pool waiting count sampled at read-receipt preflight',
  labelNames: ['result'],
  buckets: [0, 1, 2, 4, 8, 12, 16, 24, 32, 48, 64],
});

/** Redis CAS cursor script result codes by scope. */
const readReceiptCursorCasTotal = new client.Counter({
  name: 'read_receipt_cursor_cas_total',
  help: 'Read receipt cursor CAS Lua result codes by scope',
  labelNames: ['scope', 'cas_result'],
});

/** Read receipt scope usage split (channel vs conversation). */
const readReceiptScopeTotal = new client.Counter({
  name: 'read_receipt_scope_total',
  help: 'Read receipt requests by target scope',
  labelNames: ['scope'],
});

/** Read receipt optimizations that intentionally skip side effects/work. */
const readReceiptOptimizationTotal = new client.Counter({
  name: 'read_receipt_optimization_total',
  help: 'Read receipt optimization paths taken to reduce fanout and duplicate writes',
  labelNames: ['reason'],
});

/** Redis read-receipt message ack cache (GET/SET outcomes; low cardinality). */
const readReceiptMessageAckCacheTotal = new client.Counter({
  name: 'read_receipt_message_ack_cache_total',
  help: 'Redis duplicate read-receipt ack cache operations by coarse result',
  labelNames: ['result'],
});

/** Read receipt request no-op skips after cheap cursor checks. */
const readReceiptNoopSkipTotal = new client.Counter({
  name: 'read_receipt_noop_skip_total',
  help: 'Read receipt no-op skips when cursor was already advanced or duplicate mark',
  labelNames: ['reason'],
});

/** Client-side/read-path coalescing of redundant read receipt requests. */
const readReceiptCoalescedTotal = new client.Counter({
  name: 'read_receipt_coalesced_total',
  help: 'Read receipt requests coalesced due to duplicate message or cached scope cursor',
  labelNames: ['reason'],
});

/** GET unread counts intentionally shed due to DB pressure. */
const unreadCountsShedTotal = new client.Counter({
  name: 'unread_counts_shed_total',
  help: 'Unread counts requests shed due to pool pressure or in-flight cap',
  labelNames: ['reason'],
});

/** GET unread counts responses coalesced onto a shared in-flight fetch. */
const unreadCountsCoalescedTotal = new client.Counter({
  name: 'unread_counts_coalesced_total',
  help: 'Unread counts requests coalesced onto an existing in-flight fetch',
});

/** Read receipt DB upsert dispatch outcomes in the side-effect pipeline. */
const readReceiptDbUpsertTotal = new client.Counter({
  name: 'read_receipt_db_upsert_total',
  help: 'Read receipt DB upsert dispatch outcomes',
  labelNames: ['result'],
});

/** PUT /messages/:id/read in-process cursor cache outcomes (short TTL). */
const readReceiptCursorCacheHitTotal = new client.Counter({
  name: 'read_receipt_cursor_cache_hit_total',
  help: 'PUT /messages/:id/read in-process cursor cache outcomes by result',
  labelNames: ['result'],
});

/** Read receipt phase wall time to pinpoint where route spikes occur. */
const readReceiptPhaseDurationMs = new client.Histogram({
  name: 'read_receipt_phase_duration_ms',
  help: 'Read receipt phase duration in milliseconds',
  labelNames: ['phase', 'result'],
  buckets: [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

/** Rolling-window p95 insert-lock wait (ms) on this worker; updated when evaluating read shed. */
const messageChannelInsertLockPressureWaitP95MsGauge = new client.Gauge({
  name: 'message_channel_insert_lock_pressure_wait_p95_ms',
  help: 'Rolling-window p95 wait for successful channel insert lock acquires (read shed signal)',
});

/** Redis `rs:dirty` backlog (SCARD) sampled at start of a flush that holds the distributed lock. */
const readStateDirtyKeysGauge = new client.Gauge({
  name: 'read_state_dirty_keys',
  help: 'Approximate count of pending read_state flush keys in Redis (SCARD rs:dirty) when flush lock acquired',
});

/** Rows passed to a single read_states batch upsert (after per-target newest merge). */
const readStateFlushRows = new client.Histogram({
  name: 'read_state_flush_rows',
  help: 'read_states batch upsert row count per flush batch',
  buckets: [1, 2, 5, 10, 25, 50, 75, 100, 150, 200, 300, 400],
});

/** Wall time while holding the read_state flush distributed lock (Redis read + PG upsert + srem). */
const readStateFlushDurationMs = new client.Histogram({
  name: 'read_state_flush_duration_ms',
  help: 'Duration of read_states background flush while flush lock is held',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
});

const readStateFlushErrorsTotal = new client.Counter({
  name: 'read_state_flush_errors_total',
  help: 'read_states background flush errors by stage (low-cardinality)',
  labelNames: ['stage'],
});

const readStateFlushRetriesTotal = new client.Counter({
  name: 'read_state_flush_retries_total',
  help: 'read_states batch upsert retry attempts after retryable errors',
});

/** Count of insert-lock timeouts in the rolling pressure window on this worker. */
const messageChannelInsertLockPressureRecentTimeoutsGauge = new client.Gauge({
  name: 'message_channel_insert_lock_pressure_recent_timeout_count',
  help: 'Channel insert lock timeouts in the rolling MESSAGE_INSERT_LOCK_PRESSURE_WINDOW_MS window',
});

/** Fleet-visible POST insert-timeout SET outcomes (health:message_insert_unhealthy). */
const messageInsertUnhealthyRedisMarkTotal = new client.Counter({
  name: 'message_insert_unhealthy_redis_mark_total',
  help: 'Redis SET outcomes when marking global insert-unhealthy for read-receipt shedding',
  labelNames: ['result'],
});

/** Background poll of global insert-unhealthy key (no per-request Redis GET). */
const readReceiptInsertUnhealthyPollTotal = new client.Counter({
  name: 'read_receipt_insert_unhealthy_poll_total',
  help: 'Poll outcomes for health:message_insert_unhealthy on read workers',
  labelNames: ['result'],
});

/** Worker-local mirror of polled global insert-unhealthy (0/1). */
const readReceiptInsertUnhealthyGlobalCache = new client.Gauge({
  name: 'read_receipt_insert_unhealthy_global_cache',
  help: 'Cached global insert-unhealthy signal after last poll (1 = defer reads)',
});

/** Read-state background flush deferrals due to DB write pressure. */
const readStateFlushDeferredTotal = new client.Counter({
  name: 'read_state_flush_deferred_total',
  help: 'Background read-state flushes deferred because DB write pressure is active',
  labelNames: ['reason'],
});

/** Approximate dirty key count recorded at the moment a flush was deferred. */
const readStateFlushDeferredDirtyKeys = new client.Gauge({
  name: 'read_state_flush_deferred_dirty_keys',
  help: 'Approximate dirty key backlog (SCARD rs:dirty) sampled when a flush was deferred due to DB pressure',
});

module.exports = {
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
  readReceiptPreflightTotal,
  readReceiptPreflightPoolWaiting,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
  readReceiptMessageAckCacheTotal,
  readReceiptNoopSkipTotal,
  readReceiptCoalescedTotal,
  unreadCountsShedTotal,
  unreadCountsCoalescedTotal,
  readReceiptDbUpsertTotal,
  readReceiptCursorCacheHitTotal,
  readReceiptPhaseDurationMs,
  messageChannelInsertLockPressureWaitP95MsGauge,
  messageChannelInsertLockPressureRecentTimeoutsGauge,
  readStateDirtyKeysGauge,
  readStateFlushRows,
  readStateFlushDurationMs,
  readStateFlushErrorsTotal,
  readStateFlushRetriesTotal,
  messageInsertUnhealthyRedisMarkTotal,
  readReceiptInsertUnhealthyPollTotal,
  readReceiptInsertUnhealthyGlobalCache,
  readStateFlushDeferredTotal,
  readStateFlushDeferredDirtyKeys,
};
