
const client = require('prom-client');

client.register.setDefaultLabels({
  service: 'chatapp-api',
  env: process.env.NODE_ENV || 'development',
});

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.).
// prom-client's default GC buckets jump from 100ms to 1s; that makes p99
// interpolate near 1s when only a few collections cross 100ms. Keep finer
// buckets around the SLO-relevant tail so worker-level dashboards stay useful.
client.collectDefaultMetrics({
  gcDurationBuckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 5],
});

const {
  httpRequestsTotal,
  httpRequestDurationMs,
  httpRequestsAbortedTotal,
  httpOverloadShedTotal,
  presenceFanoutTotal,
  presenceSnapshotWriteAttemptTotal,
  presenceSnapshotWriteSkippedTotal,
  presenceSnapshotBatchSize,
  presenceSnapshotFlushDurationMs,
  fanoutRecipientsHistogram,
} = require('./metrics/httpPresence');
const {
  presenceFanoutTargetsInvalidationTotal,
  presenceFanoutTargetsInvalidationKeysTotal,
  presenceFanoutTargetsInvalidationDurationMs,
} = require('./metrics/presenceFanoutTargetsInvalidation');
const {
  opensearchBulkTotal,
  opensearchBulkDurationMs,
  opensearchBulkDocs,
  opensearchRequestErrorsTotal,
} = require('./metrics/openSearchWriteMetrics');

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
  authSessionFlowTotal,
} = require('./metrics/sideEffectAndAuth');
const {
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
  searchFreshnessCacheHitsTotal,
  searchFreshnessCacheMissesTotal,
  searchFreshnessSkippedShortQueryTotal,
  searchEmptyMeiliRecentRescueTotal,
  searchEmptyMeiliRecentRescueDurationMs,
  searchEmptyMeiliRecentRescueRowsScanned,
  searchEmptyMeiliRecentRescueResults,
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
  messageListCacheStoreSkippedTotal,
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
  wsReplayDegradedTotal,
  wsReplaySkippedTotal,
  wsReplayDbTimeoutTotal,
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
  wsReplayCacheMetadataMismatchTotal,
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
  wsActiveSubscriberTargetsBucket,
  wsFanoutCandidateCountBucket,
  wsFanoutOfflineSkippedTotal,
  wsFanoutActiveTargetHitTotal,
  wsFanoutActiveTargetMissTotal,
  wsFanoutRecoveryInlineTotal,
  wsFanoutRecoveryAsyncTotal,
  redisExistsByPathTotal,
  wsSocketSendTargetsBucket,
  wsRecipientDuplicateCandidatesTotal,
  wsRecipientDedupeTotal,
  wsDuplicateDeliverySuppressedTotal,
  wsDedupeEnqueueReservedTotal,
  wsDedupeSendConfirmedTotal,
  wsDedupeSendFailedTotal,
  fanoutRecentConnectCacheTotal,
  fanoutRecentConnectZsetSize,
  wsBootstrapListCacheTotal,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapHydrationQueueDepth,
  wsBootstrapHydrationDelayMs,
  wsBootstrapHydrationActive,
  wsBootstrapHydrationDeferredTotal,
  wsBootstrapHydrationSkippedTotal,
  wsBootstrapHydrationCooldownActive,
  wsBootstrapCoalescedTotal,
  wsBootstrapChannelListCacheTotal,
  wsLiveFanoutStarvationGuardTotal,
  wsBootstrapPausedForLiveFanoutTotal,
  wsBootstrapReplicaReadTotal,
  wsBootstrapReplicaFallbackTotal,
  wsBootstrapDbQueryDurationMs,
  wsBootstrapHydrationStepDurationMs,
  wsPartialDeliveryMissingReasonTotal,
  wsPubsubMessagesTotal,
  wsPubsubRecipientSlotsTotal,
  wsUserfeedEnvelopeUsersTotal,
  wsUserfeedLocalRecipientsTotal,
  wsUserfeedPublishCallsTotal,
  wsUserfeedPublishTargetsTotal,
  wsUserfeedOwnedShardsGauge,
  wsUserfeedShardSubscriptionTotal,
} = require('./metrics/wsRuntimeAndDelivery');
const {
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
} = require('./metrics/messageWritePath');
const {
  msgTargetCacheTotal,
  msgTargetLookupSourceTotal,
  msgTargetLookupDurationMs,
} = require('./metrics/msgTargetAccess');

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
    wsDisconnectReasonTotal.inc({ reason: 'heartbeat_timeout' }, 0);
    wsDisconnectReasonTotal.inc({ reason: 'upstream_terminate' }, 0);
    wsDisconnectReasonTotal.inc({ reason: 'client_close' }, 0);
    wsDisconnectReasonTotal.inc({ reason: 'auth_revoke' }, 0);
    wsDisconnectReasonTotal.inc({ reason: 'network_abnormal' }, 0);
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
    authSessionFlowTotal.inc({ path: 'login', mode: 'fresh', result: 'success' }, 0);
    authSessionFlowTotal.inc({ path: 'login', mode: 'after_refresh_failure', result: 'success' }, 0);
    authSessionFlowTotal.inc({ path: 'refresh', mode: 'cookie', result: 'success' }, 0);
    authSessionFlowTotal.inc({ path: 'session', mode: 'refresh_cookie', result: 'success' }, 0);
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
    messageCacheBustWallDurationMs.observe({ scope: 'channel' }, 0);
    messageCacheBustWallDurationMs.observe({ scope: 'conversation' }, 0);
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
    fanoutQueueDepth.set({ queue: 'fanout:read_receipt' }, 0);
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
    readReceiptShedTotal.inc({ reason: 'message_insert_unhealthy' }, 0);
    readReceiptShedTotal.inc({ reason: 'overload_stage_high' }, 0);
    readReceiptShedTotal.inc({ reason: 'ws_delivery_pressure' }, 0);
    readReceiptRequestsTotal.inc(
      { result: 'deferred_message_channel_insert_lock_pressure' },
      0,
    );
    readReceiptRequestsTotal.inc({ result: 'deferred_message_insert_unhealthy' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_ws_delivery_pressure' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_ws_delivery_pressure_fanout_only' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_pool_waiting' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_overload_stage_high' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_overload_fanout_only' }, 0);
    readReceiptRequestsTotal.inc({ result: 'deferred_fanout_disabled' }, 0);
    readReceiptRequestsTotal.inc({ result: 'not_found' }, 0);
    readReceiptRequestsTotal.inc({ result: 'access_denied' }, 0);
    readReceiptRequestsTotal.inc({ result: 'success' }, 0);
    readReceiptPreflightTotal.inc({ result: 'deferred_message_channel_insert_lock_pressure' }, 0);
    readReceiptPreflightTotal.inc({ result: 'deferred_message_insert_unhealthy' }, 0);
    readReceiptPreflightTotal.inc({ result: 'deferred_ws_delivery_pressure' }, 0);
    readReceiptPreflightTotal.inc({ result: 'deferred_pool_waiting' }, 0);
    readReceiptPreflightTotal.inc({ result: 'deferred_overload_stage_high' }, 0);
    readReceiptPreflightTotal.inc({ result: 'pass' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'deferred_message_channel_insert_lock_pressure' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'deferred_message_insert_unhealthy' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'deferred_ws_delivery_pressure' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'deferred_pool_waiting' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'deferred_overload_stage_high' }, 0);
    readReceiptPreflightPoolWaiting.observe({ result: 'pass' }, 0);
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
    readReceiptOptimizationTotal.inc({ reason: 'conversation_read_reliable_fanout' }, 0);
    readReceiptOptimizationTotal.inc({ reason: 'channel_read_fanout_inline_fallback' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'cursor_not_advanced' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'same_message_coalesced' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'same_message_recent_confirmed' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'scope_burst_debounced' }, 0);
    unreadCountsShedTotal.inc({ reason: 'pool_waiting' }, 0);
    unreadCountsShedTotal.inc({ reason: 'inflight_cap' }, 0);
    unreadCountsCoalescedTotal.inc(0);
    readReceiptNoopSkipTotal.inc({ reason: 'scope_cursor_cache' }, 0);
    readReceiptNoopSkipTotal.inc({ reason: 'redis_message_ack_cache' }, 0);
    readReceiptMessageAckCacheTotal.inc({ result: 'hit' }, 0);
    readReceiptMessageAckCacheTotal.inc({ result: 'miss' }, 0);
    readReceiptMessageAckCacheTotal.inc({ result: 'get_error' }, 0);
    readReceiptMessageAckCacheTotal.inc({ result: 'set_ok' }, 0);
    readReceiptMessageAckCacheTotal.inc({ result: 'set_error' }, 0);
    readReceiptCoalescedTotal.inc({ reason: 'same_message' }, 0);
    readReceiptCoalescedTotal.inc({ reason: 'scope_cursor' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'enqueued' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'rate_limited' }, 0);
    readReceiptDbUpsertTotal.inc({ result: 'noop' }, 0);
    readReceiptCursorCacheHitTotal.inc({ result: 'hit' }, 0);
    readReceiptCursorCacheHitTotal.inc({ result: 'miss' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'target_lookup', result: 'ok' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'target_lookup', result: 'error' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'cursor_advance', result: 'ok' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'cursor_advance', result: 'error' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'watermark_cache', result: 'ok' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'watermark_cache', result: 'error' }, 0);
    messageInsertUnhealthyRedisMarkTotal.inc({ result: 'ok' }, 0);
    messageInsertUnhealthyRedisMarkTotal.inc({ result: 'error' }, 0);
    readReceiptInsertUnhealthyPollTotal.inc({ result: 'hit' }, 0);
    readReceiptInsertUnhealthyPollTotal.inc({ result: 'miss' }, 0);
    readReceiptInsertUnhealthyPollTotal.inc({ result: 'error' }, 0);
    readReceiptInsertUnhealthyGlobalCache.set(0);
    readReceiptPhaseDurationMs.observe({ phase: 'fanout_publish', result: 'ok' }, 0);
    readReceiptPhaseDurationMs.observe({ phase: 'fanout_publish', result: 'error' }, 0);
    messageChannelInsertLockPressureWaitP95MsGauge.set(0);
    messageChannelInsertLockPressureRecentTimeoutsGauge.set(0);
    readStateDirtyKeysGauge.set(0);
    readStateFlushRows.observe(1);
    readStateFlushDurationMs.observe(0);
    readStateFlushErrorsTotal.inc({ stage: 'scard' }, 0);
    readStateFlushErrorsTotal.inc({ stage: 'dirty_keys' }, 0);
    readStateFlushErrorsTotal.inc({ stage: 'pending_pipeline' }, 0);
    readStateFlushErrorsTotal.inc({ stage: 'upsert' }, 0);
    readStateFlushErrorsTotal.inc({ stage: 'clear_dirty' }, 0);
    readStateFlushRetriesTotal.inc(0);
    readStateFlushDeferredTotal.inc({ reason: 'insert_unhealthy' }, 0);
    readStateFlushDeferredTotal.inc({ reason: 'flush_pressure' }, 0);
    readStateFlushDeferredDirtyKeys.set(0);
    presenceSnapshotWriteAttemptTotal.inc(0);
    presenceSnapshotWriteSkippedTotal.inc({ reason: 'debounced' }, 0);
    presenceSnapshotBatchSize.observe(0);
    presenceSnapshotFlushDurationMs.observe(0);
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
    messageListCacheStoreSkippedTotal.inc({ scope: 'channel', reason: 'epoch_changed' }, 0);
    messageListCacheStoreSkippedTotal.inc({ scope: 'conversation', reason: 'epoch_changed' }, 0);
    endpointListCacheBypassTotal.inc({ endpoint: 'messages_channel', reason: 'pagination' }, 0);
    endpointListCacheBypassTotal.inc({ endpoint: 'messages_conversation', reason: 'pagination' }, 0);
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'messages_channel', reason: 'message_list_volatile' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'messages_conversation', reason: 'message_list_volatile' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'conversations', reason: 'structural_conversation_change' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'conversations', reason: 'membership_change' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'channels', reason: 'structural_channel_change' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'channels', reason: 'membership_change' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'communities', reason: 'structural_community_change' },
      0,
    );
    endpointListCacheInvalidationsTotal.inc(
      { endpoint: 'communities', reason: 'membership_change' },
      0,
    );
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
    wsBootstrapListCacheTotal.inc({ result: 'stale' }, 0);
    wsBootstrapListCacheTotal.inc({ result: 'coalesced' }, 0);
    wsBootstrapBlockedTotal.inc({ reason: 'concurrency_cap' }, 0);
    wsBootstrapBlockedTotal.inc({ reason: 'concurrency_wait_timeout' }, 0);
    wsBootstrapCachedTotal.inc({ source: 'ttl' }, 0);
    wsBootstrapCachedTotal.inc({ source: 'inflight' }, 0);
    wsBootstrapDbTotal.inc(0);
    wsBootstrapChannelsHistogram.observe(0);
    wsReadyWallDurationMs.observe({ mode: 'strict' }, 0);
    wsReadyWallDurationMs.observe({ mode: 'progressive' }, 0);
    wsBootstrapProgressiveTotal.inc({ result: 'ready_sent' }, 0);
    wsBootstrapProgressiveTotal.inc({ result: 'hydration_complete' }, 0);
    wsBootstrapProgressiveTotal.inc({ result: 'hydration_skipped' }, 0);
    wsBootstrapProgressiveTotal.inc({ result: 'hydration_failed' }, 0);
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
    wsReplayFailOpenTotal.inc({ reason: 'db_pressure' }, 0);
    wsReplayStartedTotal.inc(0);
    wsReplayDegradedTotal.inc({ reason: 'db_pressure' }, 0);
    wsReplaySkippedTotal.inc({ reason: 'db_pressure' }, 0);
    wsReplaySkippedTotal.inc({ reason: 'global_concurrency' }, 0);
    wsReplayDbTimeoutTotal.inc(0);
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
    channelMessageFanoutRecipientTotal.inc({ segment: 'channel_topic_skipped' }, 0);
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
    for (const caller of ['read_receipt', 'other'] as const) {
      for (const shape of ['lite', 'full'] as const) {
        for (const result of [
          'hit',
          'miss',
          'stale_version',
          'parse_error',
          'redis_error',
          'disabled',
        ] as const) {
          msgTargetCacheTotal.inc({ caller, shape, result }, 0);
        }
        for (const source of [
          'cache',
          'replica',
          'primary_fallback',
          'primary_direct',
          'error',
        ] as const) {
          msgTargetLookupSourceTotal.inc({ caller, shape, source }, 0);
          msgTargetLookupDurationMs.observe({ caller, shape, source }, 0);
        }
      }
    }
    for (const mode of ['single', 'bulk'] as const) {
      for (const command of ['unlink', 'del_fallback'] as const) {
        presenceFanoutTargetsInvalidationTotal.inc({ mode, command }, 0);
      }
    }
    presenceFanoutTargetsInvalidationKeysTotal.inc({ mode: 'bulk' }, 0);
    presenceFanoutTargetsInvalidationDurationMs.observe({ mode: 'single' }, 0);
    presenceFanoutTargetsInvalidationDurationMs.observe({ mode: 'bulk' }, 0);
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
    for (const result of ['success', 'error'] as const) {
      opensearchBulkTotal.inc({ result }, 0);
      opensearchBulkDurationMs.observe({ result }, 0);
    }
    for (const operation of ['index_doc', 'bulk', 'update', 'delete', 'create_index'] as const) {
      opensearchRequestErrorsTotal.inc({ operation }, 0);
    }
    opensearchBulkDocs.inc(0);
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
  presenceSnapshotWriteAttemptTotal,
  presenceSnapshotWriteSkippedTotal,
  presenceSnapshotBatchSize,
  presenceSnapshotFlushDurationMs,
  presenceFanoutTargetsInvalidationTotal,
  presenceFanoutTargetsInvalidationKeysTotal,
  presenceFanoutTargetsInvalidationDurationMs,
  opensearchBulkTotal,
  opensearchBulkDurationMs,
  opensearchBulkDocs,
  opensearchRequestErrorsTotal,
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
  authSessionFlowTotal,
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
  readStateFlushDeferredTotal,
  readStateFlushDeferredDirtyKeys,
  messageInsertUnhealthyRedisMarkTotal,
  readReceiptInsertUnhealthyPollTotal,
  readReceiptInsertUnhealthyGlobalCache,
  wsConnectionResultTotal,
  wsBackpressureEventsTotal,
  channelAccessCacheTotal,
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
  wsReplayCacheMetadataMismatchTotal,
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
  wsActiveSubscriberTargetsBucket,
  wsFanoutCandidateCountBucket,
  wsFanoutOfflineSkippedTotal,
  wsFanoutActiveTargetHitTotal,
  wsFanoutActiveTargetMissTotal,
  wsFanoutRecoveryInlineTotal,
  wsFanoutRecoveryAsyncTotal,
  redisExistsByPathTotal,
  wsSocketSendTargetsBucket,
  wsRecipientDuplicateCandidatesTotal,
  wsRecipientDedupeTotal,
  wsDuplicateDeliverySuppressedTotal,
  wsDedupeEnqueueReservedTotal,
  wsDedupeSendConfirmedTotal,
  wsDedupeSendFailedTotal,
  fanoutRecentConnectCacheTotal,
  fanoutRecentConnectZsetSize,
  wsBootstrapListCacheTotal,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapChannelsHistogram,
  messageCacheBustFailuresTotal,
  messageCacheBustWallDurationMs,
  searchReplicaRetryTotal,
  searchDbBackendTotal,
  searchResultsReturnedHistogram,
  searchThrottledTotal,
  searchQueryDurationMs,
  searchFreshnessQueryDurationMs,
  searchFreshnessRescueWallDurationMs,
  meiliRecheckDurationMs,
  searchHandlerOverheadMs,
  searchFreshnessCacheHitsTotal,
  searchFreshnessCacheMissesTotal,
  searchFreshnessSkippedShortQueryTotal,
  searchEmptyMeiliRecentRescueTotal,
  searchEmptyMeiliRecentRescueDurationMs,
  searchEmptyMeiliRecentRescueRowsScanned,
  searchEmptyMeiliRecentRescueResults,
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
  messageListCacheStoreSkippedTotal,
  endpointListCacheBypassTotal,
  endpointListCacheInvalidationsTotal,
  messagesListAccessCacheHitTotal,
  apiRateLimitHitsTotal,
  wsUpgradeSeenTotal,
  wsUpgradeRateLimitedTotal,
  wsReplayFailOpenTotal,
  wsReplayStartedTotal,
  wsReplayDegradedTotal,
  wsReplaySkippedTotal,
  wsReplayDbTimeoutTotal,
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
  msgTargetCacheTotal,
  msgTargetLookupSourceTotal,
  msgTargetLookupDurationMs,
  wsBootstrapHydrationQueueDepth,
  wsBootstrapHydrationDelayMs,
  wsBootstrapHydrationActive,
  wsBootstrapHydrationDeferredTotal,
  wsBootstrapHydrationSkippedTotal,
  wsBootstrapHydrationCooldownActive,
  wsBootstrapCoalescedTotal,
  wsBootstrapChannelListCacheTotal,
  wsLiveFanoutStarvationGuardTotal,
  wsBootstrapPausedForLiveFanoutTotal,
  wsBootstrapDbQueryDurationMs,
  wsBootstrapReplicaReadTotal,
  wsBootstrapReplicaFallbackTotal,
  wsBootstrapHydrationStepDurationMs,
  wsPartialDeliveryMissingReasonTotal,
  wsPubsubMessagesTotal,
  wsPubsubRecipientSlotsTotal,
  wsUserfeedEnvelopeUsersTotal,
  wsUserfeedLocalRecipientsTotal,
  wsUserfeedPublishCallsTotal,
  wsUserfeedPublishTargetsTotal,
  wsUserfeedOwnedShardsGauge,
  wsUserfeedShardSubscriptionTotal,
};
