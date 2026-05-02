/**
 * WebSocket runtime/replay/reliability/fanout and related last-message metrics.
 */

const client = require('prom-client');

/** WebSocket connection outcomes (upgrade + auth + bootstrap failures). */
const wsConnectionResultTotal = new client.Counter({
  name: 'ws_connection_result_total',
  help: 'WebSocket outcomes after upgrade (auth failures, subscribe failures, etc.)',
  labelNames: ['result'],
});

/** WS HTTP upgrade attempts seen by Node (before auth). */
const wsUpgradeSeenTotal = new client.Counter({
  name: 'ws_upgrade_seen_total',
  help: 'WebSocket upgrade requests reaching the Node process',
});

/** WS upgrades rejected by in-process token bucket (429 at TCP layer). */
const wsUpgradeRateLimitedTotal = new client.Counter({
  name: 'ws_upgrade_rate_limited_total',
  help: 'WebSocket upgrades rejected by app-layer per-IP rate limit',
});

/** Reconnect replay skipped immediately (fail-open empty), by reason. */
const wsReplayFailOpenTotal = new client.Counter({
  name: 'ws_replay_fail_open_total',
  help: 'WS reconnect replay skipped without DB work (pressure / caps / disabled)',
  labelNames: ['reason'],
});

/** Reconnect replay DB loads started (after admission + jitter). */
const wsReplayStartedTotal = new client.Counter({
  name: 'ws_replay_started_total',
  help: 'WS reconnect replay DB loads started',
});

/** Current reconnect replay DB loads in flight on this process. */
const wsReplayConcurrentGauge = new client.Gauge({
  name: 'chatapp_ws_replay_inflight',
  help: 'Concurrent WS reconnect replay DB transactions on this worker',
});

/** Effective reconnect replay semaphore cap configured on this process. */
const wsReplaySemaphoreCapGauge = new client.Gauge({
  name: 'chatapp_ws_replay_semaphore_cap',
  help: 'Configured max concurrent WS reconnect replay DB transactions on this worker',
});

/** App-layer subnet block (BLOCK_SUBNETS). */
const abuseBlockedSubnetTotal = new client.Counter({
  name: 'abuse_blocked_subnet_total',
  help: 'HTTP requests rejected with 403 due to BLOCK_SUBNETS match',
});

/** HTTP requests rejected with 403 due to Redis-backed AUTO_IP_BAN (temporary). */
const abuseAutoBanBlocksTotal = new client.Counter({
  name: 'abuse_auto_ban_blocks_total',
  help: 'HTTP requests blocked by automatic temporary IP ban (AUTO_IP_BAN)',
});

/** Times an external IP was placed on the temporary ban list after sustained rate-limit strikes. */
const abuseAutoBanIssuedTotal = new client.Counter({
  name: 'abuse_auto_ban_issued_total',
  help: 'Automatic temporary IP bans issued (Redis key set)',
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

const wsDisconnectReasonTotal = new client.Counter({
  name: 'ws_disconnect_reason_total',
  help: 'WebSocket disconnects grouped by classified reason',
  labelNames: ['reason'],
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

/** Reconnect replay duplicate suppressed within short TTL (same replay window fingerprint). */
const wsReplayDedupedTotal = new client.Counter({
  name: 'ws_replay_deduped_total',
  help: 'WS reconnect replay skipped as duplicate of a very recent identical replay for the same user',
});

/** WS reconnect replay served from short-TTL cache before DB. */
const wsReplayCachedTotal = new client.Counter({
  name: 'ws_replay_cached_total',
  help: 'WS reconnect replay served from short-TTL cache by user+cursor before DB',
});

/** Reconnect replay Postgres round-trips actually started (after dedupe admission). */
const wsReplayDbQueryTotal = new client.Counter({
  name: 'ws_replay_db_query_total',
  help: 'WS reconnect replay DB transactions started (excludes dedupe and pre-DB skips)',
});

/** Reconnect replay query outcomes so we can verify replay is bounded under load. */
const wsReplayQueryTotal = new client.Counter({
  name: 'ws_replay_query_total',
  help: 'Reconnect replay query outcomes for websocket missed-message backfill',
  labelNames: ['result'],
});

/** Replay DB/query errors grouped by classified root cause. */
const wsReplayErrorClassTotal = new client.Counter({
  name: 'ws_replay_error_class_total',
  help: 'Reconnect replay errors by classified root cause (timeout, pool_busy, error)',
  labelNames: ['error_class'],
});

/** Wall-clock duration for reconnect replay DB work (successful or failed-open). */
const wsReplayQueryDurationMs = new client.Histogram({
  name: 'ws_replay_query_duration_ms',
  help: 'Milliseconds spent loading reconnect replay messages from Postgres',
  labelNames: ['result'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000],
});

/** Pending replay user ZSET trims when cardinality cap is enforced. */
const wsPendingReplayUserTrimmedTotal = new client.Counter({
  name: 'ws_pending_replay_user_trimmed_total',
  help: 'Pending replay ZSET members trimmed due to per-user cardinality cap',
});

/** Distribution of ws:pending:user:* zset cardinality after enqueue+trim. */
const wsPendingUserZsetSize = new client.Histogram({
  name: 'ws_pending_user_zset_size',
  help: 'Cardinality of ws:pending:user:* after enqueue path processing',
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

/** Nonessential pending replay write skipped by emergency memory guard. */
const wsPendingReplayGuardTotal = new client.Counter({
  name: 'ws_pending_replay_guard_total',
  help: 'Pending replay writes skipped due to Redis memory guard activation',
  labelNames: ['reason'],
});

/**
 * Reliable WS payloads actually written to a socket (after dedupe / backpressure gates).
 * path=realtime: Redis pub/sub → local fanout. path=replay: reconnect backfill (missed DB rows
 * or pending-queue drain). Latency uses message created_at / publishedAt when parseable.
 */
const wsReliableDeliveryTotal = new client.Counter({
  name: 'ws_reliable_delivery_total',
  help: 'Reliable websocket events delivered to a client (post-dedupe, pre-ws.send)',
  labelNames: ['path', 'source'],
});

/** Wall-clock ms from payload reference time (created_at / publishedAt) to socket send. */
const wsReliableDeliveryLatencyMs = new client.Histogram({
  name: 'ws_reliable_delivery_latency_ms',
  help: 'Milliseconds from message/event reference time to ws.send for reliable deliveries',
  labelNames: ['path'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 3600000],
});

/** Reliable deliveries split by Redis logical topic prefix (channel-first migration / grader tuning). */
const wsReliableDeliveryTopicTotal = new client.Counter({
  name: 'ws_reliable_delivery_topic_total',
  help: 'Reliable websocket deliveries by path and logical Redis channel prefix (message:* and related)',
  labelNames: ['path', 'topic_prefix'],
});

/**
 * Channel message:created user-topic fanout volume by segment (candidate list vs inline Redis
 * publish vs deferred side-effect queue). Use deferred / candidate ratio with replay rate.
 */
const channelMessageFanoutRecipientTotal = new client.Counter({
  name: 'channel_message_fanout_recipient_total',
  help: 'Recipient slots for channel message user-topic fanout by segment',
  labelNames: ['segment'],
});

/**
 * Actionable signals for realtime gaps (grader: mean delivery up, p95 flat). Not exhaustive
 * classification — combine with ws_reliable_delivery_total, ws_reconnects_total, fanout_job_*, logs.
 */
const realtimeMissAttributionTotal = new client.Counter({
  name: 'realtime_miss_attribution_total',
  help: 'Correlates with delayed or non-immediate realtime delivery before replay recovery',
  labelNames: ['reason'],
});

/** Per-user classification when enqueueing ws:pending:user:* pointers (filtering mode). */
const pendingReplayRecipientTotal = new client.Counter({
  name: 'pending_replay_recipient_total',
  help:
    'Users per message:connected=active WS (user:<id>:connections); recent=no socket but ws:pending_eligible (or hinted recentTargets) or legacy markers; offline_skipped=fully offline; legacy_enqueue=all targets',
  labelNames: ['class'],
});

/** Count of eligible users written to ws:pending:user:* per message:created pending enqueue. */
const pendingReplayEntriesPerMessage = new client.Histogram({
  name: 'pending_replay_entries_per_message',
  help: 'Number of ws:pending:user zset entries added for one pending-replay enqueue',
  buckets: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233],
});

/** Users classified `recent` via phase-2 EXISTS(ws:recent_connect/replay_pending) after unified key miss. */
const pendingReplaySecondProbeRecentUserTotal = new client.Counter({
  name: 'pending_replay_second_probe_recent_user_total',
  help:
    'Users added to pending replay after phase-2 marker EXISTS: conversation_marker = legacy off + no recentTargets opt; legacy_global = WS_PENDING_ELIGIBLE_LEGACY_FALLBACK=true',
  labelNames: ['mode'],
});

/** Users skipped for pending replay (fully offline / no recent session marker). */
const offlinePendingSkippedTotal = new client.Counter({
  name: 'offline_pending_skipped_total',
  help: 'Fanout targets skipped for ws:pending:user enqueue because not connected or recently connected',
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

/** last_message pointer update written to the async queue (Redis-backed, deferred from the POST /messages path). */
const channelLastMessageUpdateDeferredTotal = new client.Counter({
  name: 'channel_last_message_update_deferred_total',
  help: 'last_message pointer update enqueued to async Redis-backed queue (channel or conversation)',
  labelNames: ['target'],
});

/** last_message pointer update successfully written to DB by the background flush. */
const channelLastMessageUpdateFlushedTotal = new client.Counter({
  name: 'channel_last_message_update_flushed_total',
  help: 'last_message pointer DB UPDATE committed by the background interval flush (channel or conversation)',
  labelNames: ['target'],
});

/** last_message pointer DB flush failed (Redis error or query error). */
const channelLastMessageUpdateFailedTotal = new client.Counter({
  name: 'channel_last_message_update_failed_total',
  help: 'last_message pointer flush failed (Redis write or DB UPDATE error) for channel or conversation',
  labelNames: ['target'],
});

const lastMessageRedisUpdateTotal = new client.Counter({
  name: 'last_message_redis_update_total',
  help: 'Latest-message metadata writes to Redis by target and outcome',
  labelNames: ['target', 'result'],
});

const lastMessagePgReconcileTotal = new client.Counter({
  name: 'last_message_pg_reconcile_total',
  help: 'Latest-message metadata DB reconcile attempts by target and outcome',
  labelNames: ['target', 'result'],
});

const lastMessagePgReconcileSkippedTotal = new client.Counter({
  name: 'last_message_pg_reconcile_skipped_total',
  help: 'Latest-message metadata DB reconcile skips by reason',
  labelNames: ['reason'],
});

const lastMessageCacheTotal = new client.Counter({
  name: 'last_message_cache_total',
  help: 'Latest-message metadata cache outcomes in read paths',
  labelNames: ['target', 'result'],
});

/** Wall-clock time for WS auto-subscribe bootstrap (list + batched subscribe, incl. retries). */
const wsBootstrapWallDurationMs = new client.Histogram({
  name: 'ws_bootstrap_wall_duration_ms',
  help: 'Milliseconds from WS connection start until auto-subscribe bootstrap completes successfully',
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000],
});

/** Wall-clock time from WS connection start until the server emits the ready event. */
const wsReadyWallDurationMs = new client.Histogram({
  name: 'ws_ready_wall_duration_ms',
  help: 'Milliseconds from WS connection start until the ready event is sent',
  labelNames: ['mode'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 30000],
});

/** Progressive-bootstrap background hydration outcomes. */
const wsBootstrapProgressiveTotal = new client.Counter({
  name: 'ws_bootstrap_progressive_total',
  help: 'Progressive WS bootstrap outcomes after early ready',
  labelNames: ['result'],
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

/** Number of logical targets considered before recent-connect filtering or inline publish. */
const fanoutTargetCandidatesHistogram = new client.Histogram({
  name: 'fanout_target_candidates',
  help: 'Number of logical user targets considered before recent-connect filtering or inline publish',
  labelNames: ['path'],
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** In-process cache outcomes for recent-connect target resolution in channel fanout. */
const fanoutRecentConnectCacheTotal = new client.Counter({
  name: 'fanout_recent_connect_cache_total',
  help: 'Cache outcomes for in-process channel recent-connect target resolution',
  labelNames: ['result'],
});

/** Size of the per-channel recent-connect ZSET slice returned by ZRANGEBYSCORE (before cap intersection). */
const fanoutRecentConnectZsetSize = new client.Histogram({
  name: 'fanout_recent_connect_zset_size',
  help: 'Number of member user ids in channel:recent_connect ZSET above the recency cutoff',
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Cache outcomes for WS bootstrap subscription lists. */
const wsBootstrapListCacheTotal = new client.Counter({
  name: 'ws_bootstrap_list_cache_total',
  help: 'Cache outcomes for websocket auto-subscribe channel lists',
  labelNames: ['result'],
});

/** WS bootstrap blocked/degraded before DB by ingress gating. */
const wsBootstrapBlockedTotal = new client.Counter({
  name: 'ws_bootstrap_blocked_total',
  help: 'WebSocket bootstrap blocked/degraded before DB due to ingress concurrency gating',
  labelNames: ['reason'],
});

/** WS bootstrap reused cached/inflight response before DB. */
const wsBootstrapCachedTotal = new client.Counter({
  name: 'ws_bootstrap_cached_total',
  help: 'WebSocket bootstrap reused cached or inflight response before DB list query',
  labelNames: ['source'],
});

/** WS bootstrap DB list loads started (cache miss path only). */
const wsBootstrapDbTotal = new client.Counter({
  name: 'ws_bootstrap_db_total',
  help: 'WebSocket bootstrap DB list loads started',
});

module.exports = {
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
  wsDisconnectReasonTotal,
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
  wsReadyWallDurationMs,
  wsBootstrapProgressiveTotal,
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
};
