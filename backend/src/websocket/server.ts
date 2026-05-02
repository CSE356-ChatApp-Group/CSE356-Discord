/**
 * WebSocket server
 *
 * Each WS connection authenticates via a JWT passed as a query parameter:
 *   ws://host/ws?token=<accessToken>
 *
 * After auth the client sends subscription frames:
 *   { "type": "subscribe", "channel": "channel:<uuid>" }
 *   { "type": "subscribe", "channel": "conversation:<uuid>" }
 *   { "type": "subscribe", "channel": "user:<uuid>" }   (DM notifications)
 *
 * The server subscribes the *process* to the Redis Pub/Sub channel the first
 * time any local client wants it, then broadcasts to all local sockets that
 * have subscribed to that channel.  This design scales across N API nodes –
 * each node maintains its own Redis subscriber and delivers only to its
 * locally-connected clients.
 *
 *                 ┌─────────────────────────────────────────────┐
 *                 │           Redis Pub/Sub                      │
 *                 └───────┬─────────────────────┬───────────────┘
 *                         │                     │
 *                  ┌──────▼──────┐       ┌──────▼──────┐
 *                  │  API Node 1 │       │  API Node 2 │
 *                  │  WS clients │       │  WS clients │
 *                  └─────────────┘       └─────────────┘
 *
 * Realtime throughput notes
 * -------------------------
 * The current design keeps explicit `channel:` / `conversation:` subscriptions
 * for rich clients, but now applies two important server-side reductions:
 *   • Logical `user:<id>` delivery is backed by shared Redis `userfeed:<shard>`
 *     channels, so one publish can cover many recipients on the same shard.
 *   • The default connect path auto-subscribes message-bearing `channel:` /
 *     `conversation:` topics in addition to `user:<self>`; richer
 *     `community:` subscriptions still happen explicitly from the client after
 *     it loads state.
 *
 * Outbound path: each socket has a bounded FIFO plus optional `message:*`
 * waiter backlog; Redis subscriber handlers only enqueue and return, while
 * `setImmediate` drains up to `WS_OUTBOUND_DRAIN_BATCH` `ws.send` calls per tick.
 *
 * Remaining future work, if we need another step up:
 *   • Aggregate presence/notifications server-side before WS push.
 *   • Prefer server-initiated delta sync when backpressure fires instead of
 *     growing unbounded waiters beyond `WS_OUTBOUND_MESSAGE_WAITERS_MAX`.
 *
 * SLO / UX stance for backpressure (current implementation):
 *   • **Outbound queue:** Redis→WS fanout enqueues frames per socket and drains
 *     with `setImmediate` batches so the subscriber callback does not run long
 *     `ws.send` chains. `message:*` is never dropped at enqueue (waits for capacity);
 *     best-effort frames may be dropped when their queue cap is reached.
 *   • **Drop** (buffer > WS_BACKPRESSURE_DROP_BYTES): best-effort — client may
 *     miss an ephemeral frame; acceptable for presence-style traffic if clients
 *     reconcile via REST or a periodic sync. **Not applied** to `message:*` Redis
 *     payloads so committed chat events are not silently skipped while the socket
 *     stays below the kill threshold.
 *   • **Kill** (buffer > WS_BACKPRESSURE_KILL_BYTES): connection closed — client
 *     must reconnect; target **≥ 99%** session success over a steady profile with
 *     documented headroom (see load-tests `slo` profile).
 *   • Documented expectation: after a kill, full state is recoverable via HTTP
 *     bootstrap + selective resubscribe; not silent data loss for committed writes.
 */


const { randomUUID } = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { authenticateAccessToken, verifyRefresh } = require("../utils/jwt");
const redis = require("../db/redis");
const { redisSub } = require("../db/redis");
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require("../utils/distributedSingleflight");
const { query, poolStats } = require("../db/pool");
const logger = require("../utils/logger");
const { isRuntimeLogCategoryEnabled } = require("../utils/runtimeLogControl");
const presenceService = require("../presence/service");
const { isAuthBypassEnabled, getBypassAuthContext } = require("../auth/bypass");
const { loadReplayableMessagesForUser } = require("../messages/pending/reconnectReplay");
const { drainPendingMessagesForUser } = require("../messages/pending/realtimePending");
const { markWsRecentConnect, markChannelRecentConnect } = require("./recentConnect");
const { isWsReplayDisabled } = require("../utils/abuseKillSwitch");
const { clientIpFromReq } = require("../middleware/wsUpgradeLimiter");
const { isPrivateOrInternalNetwork } = require("../utils/trustedClientIp");
const {
  allUserFeedRedisChannels,
  userIdFromTarget,
} = require("./userFeed");
const { resolvedWsRuntimeConfig } = require("./profile");
const { allCommunityFeedRedisChannels } = require("./communityFeed");
const { createWsHotLogger } = require("./hotLog");
const { createReplayAdmissionState } = require("./replayAdmissionState");
const { createWsAclCacheStore } = require("./aclCacheStore");
const { createRedisSubscriptionRegistry } = require("./subscriptionRegistry");
const { createPresenceCoordinator } = require("./presenceCoordinator");
const { createShutdownLifecycle } = require("./shutdownLifecycle");
const { createSubscriptionManager } = require("./subscriptionManager");
const { createClientMessageRouter } = require("./clientMessageRouter");
const { createDisconnectLifecycle } = require("./disconnectLifecycle");
const { createConnectionLifecycle } = require("./connectionLifecycle");
const { createStartupSubscriptionsLifecycle } = require("./startupSubscriptions");
const { createRuntimeIntervals } = require("./runtimeIntervals");
const { bindRedisSubscriber } = require("./redisSubscriberBinding");
const {
  fanoutRecipientsHistogram,
  wsConnectionResultTotal,
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
  wsBootstrapWallDurationMs,
  wsReadyWallDurationMs,
  wsBootstrapProgressiveTotal,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
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
  wsLiveFanoutStarvationGuardTotal,
  wsBootstrapPausedForLiveFanoutTotal,
  wsReplayFailOpenTotal,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
  wsRecipientDedupeTotal,
  wsRecipientDuplicateCandidatesTotal,
  wsPartialDeliveryMissingReasonTotal,
} = require("../utils/metrics");
const {
  IDLE_TTL_SECONDS,
  CONNECTION_ALIVE_TTL_SECONDS,
  PRESENCE_SWEEPER_MS,
  WS_BACKPRESSURE_DROP_BYTES,
  WS_BACKPRESSURE_KILL_BYTES,
  WS_OUTBOUND_QUEUE_MAX_MESSAGE,
  WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT,
  WS_OUTBOUND_DRAIN_BATCH,
  WS_REPLAY_OUTBOUND_YIELD_EVERY,
  WS_OUTBOUND_MESSAGE_WAITERS_MAX,
  PRESENCE_SWEEPER_DEBOUNCE_MS,
  PRESENCE_DISCONNECT_DEBOUNCE_MS,
  ACL_CACHE_TTL_MS,
  WS_ACL_REDIS_TTL_SECS,
  ACL_CACHE_MAX_ENTRIES,
  WS_BOOTSTRAP_BATCH_SIZE,
  WS_RECENT_DISCONNECT_TTL_SECONDS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_APP_KEEPALIVE_INTERVAL_MS,
  WS_APP_KEEPALIVE_FRAME,
  WS_SHUTDOWN_CLOSE_GRACE_MS,
  WS_SERVICE_RESTART_CLOSE_CODE,
  WS_SERVICE_RESTART_CLOSE_REASON,
  WS_REPLAY_USER_COOLDOWN_MS,
  WS_HOT_LOG_SAMPLE_RATE,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
} = require("./serverConfig");
const { createAppKeepaliveSender } = require("./wsAppKeepalive");

const wss = new WebSocketServer({ noServer: true });
// Backpressure thresholds for slow WS consumers.
// DROP: skip this frame if the client's write buffer exceeds 64 KB (except
//   message:* fanout frames — those still send until KILL to avoid silent loss).
//   ~130 typical frames. A client this far behind is already visibly lagging;
//   dropping one frame is better than growing the server-side buffer further.
// KILL: terminate the connection at 2 MB. The client cannot keep up at all;
//   holding 2 MB of queued frames wastes heap and blocks on TCP ACK.
/** Max queued `message:*` frames per socket (never dropped; enqueue waits with setImmediate). */
/** Max queued best-effort frames per socket (dropped at enqueue when full). */
/** Max `ws.send` calls per setImmediate drain tick per socket. */
/** After enqueueing this many replay frames on one socket, yield so the event loop serves other sockets/work. */
/** When primary queue is full, `message:*` jobs wait here (FIFO) until drain makes room. */
let shuttingDown = false;

const wsHotLogger = createWsHotLogger({
  logger,
  isRuntimeLogCategoryEnabled,
  defaultRate: WS_HOT_LOG_SAMPLE_RATE,
});
const logWsHotInfo = wsHotLogger.logWsHotInfo;
/** Concurrent reconnect-replay DB loads per public client IP (hard cap 1). RFC1918/loopback exempt. */

function isReplayIpExemptFromPerIpCap(ip) {
  return isPrivateOrInternalNetwork(ip);
}

function replayStartupJitterMs() {
  return 100 + Math.floor(Math.random() * 201);
}
const replayAdmissionState = createReplayAdmissionState({
  env: process.env,
  poolStats,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  logWsHotInfo,
  replayUserCooldownMs: WS_REPLAY_USER_COOLDOWN_MS,
  isReplayIpExemptFromPerIpCap,
  isSocketOpen: (ws) => ws.readyState === WebSocket.OPEN,
});
const {
  replayAdmissionConfig,
  getReplayInFlightCount,
  tryAcquireReplaySlot,
  releaseReplaySlot,
  canRunReplayForUser,
  tryBeginReplayForIp,
  endReplayForIp,
  waitForReplayGateOpen,
} = replayAdmissionState;
const {
  aclCache,
  aclCheckInFlight,
  aclCacheKey,
  readAclSharedCacheEntry,
  setAclDecision,
  warmWsAclCacheFromChannelList,
  invalidateWsAclCache,
} = createWsAclCacheStore({
  redis,
  aclCacheTtlMs: ACL_CACHE_TTL_MS,
  aclCacheMaxEntries: ACL_CACHE_MAX_ENTRIES,
  wsAclRedisTtlSecs: WS_ACL_REDIS_TTL_SECS,
});

async function evictUnauthorizedChannelSubscribers(channelId) {
  const redisChannel = `channel:${channelId}`;
  const clients = Array.from(channelClients.get(redisChannel) || []) as any[];
  if (!clients.length) return;

  await Promise.allSettled(
    clients.map(async (ws) => {
      const userId = ws?._userId;
      if (!userId) return;
      const allowed = await isAllowedChannel({ id: userId }, redisChannel);
      if (allowed) return;
      await unsubscribeClient(ws, redisChannel);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            event: "unsubscribed",
            data: { channel: redisChannel },
          }));
        } catch {
          // Ignore send errors while pruning stale subscribers.
        }
      }
    }),
  );
}

function isRedisOperational(client) {
  return ["wait", "connecting", "connect", "ready", "reconnecting"].includes(
    client.status,
  );
}

/**
 * Map from Redis channel key → Set of WebSocket clients subscribed to it.
 * This map is LOCAL to this process (node).
 */
const channelClients = new Map(); // key → Set<WebSocket>
const localUserClients = new Map(); // userId → Set<WebSocket>
// Sharded community feed membership. Keyed by communityId (without prefix).
const communityClients = new Map(); // communityId → Set<WebSocket>

const USER_FEED_SHARD_CHANNELS = allUserFeedRedisChannels();
const USER_FEED_SHARD_CHANNEL_SET = new Set(USER_FEED_SHARD_CHANNELS);
const COMMUNITY_FEED_SHARD_CHANNELS = allCommunityFeedRedisChannels();
const COMMUNITY_FEED_SHARD_CHANNEL_SET = new Set(COMMUNITY_FEED_SHARD_CHANNELS);
const {
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
} = createRedisSubscriptionRegistry({
  redisSub,
  isRedisOperational,
});
const { ready } = createStartupSubscriptionsLifecycle({
  ensureRedisChannelSubscribed,
  userFeedShardChannels: USER_FEED_SHARD_CHANNELS,
  communityFeedShardChannels: COMMUNITY_FEED_SHARD_CHANNELS,
  logWsHotInfo,
});

const {
  shouldSkipSocketForLogicalChannel,
  socketMessageDedupeKey,
  wasSocketMessageRecentlyDelivered,
  markSocketMessageDelivered,
  isReliableRealtimeEvent,
  wsDeliveryTopicPrefixForMetrics,
  parsePayloadReferenceTimeMs,
  prepareSocketPayload,
} = require("./outboundPayload");
const { createOutboundQueueHelpers } = require("./outboundQueue");
const {
  connectionSetKey,
  connectionStatusHashKey,
  connectionActivityKey,
  connectionAliveKey,
  connectedUsersKey,
  recentDisconnectKey,
  reconnectWindowLabel,
} = require("./presenceKeys");
const { createRecentDisconnectHelpers } = require("./recentDisconnect");
const { createPresenceActivityHelpers } = require("./presenceActivity");
const { createChannelAclHelpers } = require("./channelAcl");
const { createBootstrapSubscriptionsHelpers } = require("./bootstrapSubscriptions");
const {
  invalidateRecentConnectTargetsCache,
} = require("../messages/fanout/channelRealtimeFanout");

const {
  recordRecentDisconnect,
  recentDisconnectPayloadForSocket,
  noteRecentDisconnectForSocket,
  consumeRecentDisconnect,
  observeRecentReconnect,
} = createRecentDisconnectHelpers({
  redis,
  isRedisOperational,
  recentDisconnectKey,
  reconnectWindowLabel,
  WS_RECENT_DISCONNECT_TTL_SECONDS,
  wsReconnectsTotal,
  wsReconnectGapMs,
  logWsHotInfo,
});
const {
  markConnectionAlive,
  markConnectionActive,
  refreshConnectionTtls,
  shouldRefreshOnlinePresence,
} = createPresenceActivityHelpers({
  redis,
  connectionAliveKey,
  connectionActivityKey,
  CONNECTION_ALIVE_TTL_SECONDS,
  IDLE_TTL_SECONDS,
});
const {
  cancelPendingPresenceRecompute,
  scheduleDebouncedPresenceRecompute,
  upsertConnectionState,
  removeConnection,
  recomputeUserPresence,
  reconcileAllConnectedUsers,
} = createPresenceCoordinator({
  redis,
  presenceService,
  logger,
  connectionSetKey,
  connectionStatusHashKey,
  connectionActivityKey,
  connectionAliveKey,
  connectedUsersKey,
  presenceSweeperDebounceMs: PRESENCE_SWEEPER_DEBOUNCE_MS,
  presenceDisconnectDebounceMs: PRESENCE_DISCONNECT_DEBOUNCE_MS,
});

const {
  subscribeCommunityClient,
  unsubscribeCommunityClient,
  subscribeClient,
  unsubscribeClient,
} = createSubscriptionManager({
  localUserClients,
  channelClients,
  communityClients,
  userIdFromTarget,
  ready,
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
  markChannelRecentConnect,
  invalidateRecentConnectTargetsCache,
});
const { parseChannelKey, isAllowedChannel } = createChannelAclHelpers({
  query,
  aclCache,
  aclCheckInFlight,
  aclCacheKey,
  readAclSharedCacheEntry,
  setAclDecision,
});

// ── Redis subscriber (delivery impl: redisPubsubDelivery.ts) ───────────────────
const {
  ensureOutboundQueue,
  clearOutboundQueue,
  sendPayloadToSocket,
} = createOutboundQueueHelpers({
  WebSocket,
  logger,
  noteRecentDisconnectForSocket,
  shouldSkipSocketForLogicalChannel,
  wasSocketMessageRecentlyDelivered,
  markSocketMessageDelivered,
  isReliableRealtimeEvent,
  wsDeliveryTopicPrefixForMetrics,
  parsePayloadReferenceTimeMs,
  prepareSocketPayload,
  wsBackpressureEventsTotal,
  wsOutboundQueueDepthHistogram,
  wsOutboundQueuedFramesGauge,
  wsOutboundQueueBlockWaitsTotal,
  wsOutboundQueueDroppedBestEffortTotal,
  wsOutboundDrainBatchesTotal,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
  WS_BACKPRESSURE_DROP_BYTES,
  WS_BACKPRESSURE_KILL_BYTES,
  WS_OUTBOUND_QUEUE_MAX_MESSAGE,
  WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT,
  WS_OUTBOUND_DRAIN_BATCH,
  WS_OUTBOUND_MESSAGE_WAITERS_MAX,
});

const replayWs = require("./replay");
async function replayMissedMessagesToSocket(ws, userId, previousDisconnect, reconnectObservedAtMs) {
  return replayWs.replayMissedMessagesToSocket(
    {
      loadReplayableMessagesForUser,
      logWsHotInfo,
      sendPayloadToSocket,
      WS_REPLAY_OUTBOUND_YIELD_EVERY,
    },
    ws,
    userId,
    previousDisconnect,
    reconnectObservedAtMs,
  );
}
async function replayPendingMessagesToSocket(ws, userId) {
  return replayWs.replayPendingMessagesToSocket(
    {
      drainPendingMessagesForUser,
      sendPayloadToSocket,
      WS_REPLAY_OUTBOUND_YIELD_EVERY,
    },
    ws,
    userId,
  );
}

const maybeSendAppKeepaliveFrame = createAppKeepaliveSender({
  WebSocket,
  logger,
  noteRecentDisconnectForSocket,
  wsAppKeepaliveIntervalMs: WS_APP_KEEPALIVE_INTERVAL_MS,
  wsAppKeepaliveFrame: WS_APP_KEEPALIVE_FRAME,
  wsBackpressureDropBytes: WS_BACKPRESSURE_DROP_BYTES,
});

const {
  wsBootstrapIngressKey,
  readWsBootstrapIngressCache: readWsBootstrapIngressCacheBase,
  writeWsBootstrapIngressCache: writeWsBootstrapIngressCacheBase,
} = require("./bootstrapIngressCache");
const { createBootstrapHydrationScheduler } = require("./bootstrapHydrationScheduler");
const { createFanoutRecipientDedupe } = require("./fanoutRecipientDedupe");
const bootstrapHydrationScheduler = createBootstrapHydrationScheduler({
  wsBootstrapHydrationQueueDepth,
  wsBootstrapHydrationDelayMs,
  wsBootstrapHydrationActive,
  wsBootstrapHydrationDeferredTotal,
  wsBootstrapHydrationSkippedTotal,
  wsBootstrapHydrationCooldownActive,
  wsBootstrapCoalescedTotal,
  wsLiveFanoutStarvationGuardTotal,
  wsBootstrapPausedForLiveFanoutTotal,
});
const fanoutRecipientDedupe = createFanoutRecipientDedupe({
  wsRecipientDedupeTotal,
  wsRecipientDuplicateCandidatesTotal,
});
const {
  invalidateWsBootstrapCache,
  invalidateWsBootstrapCaches,
  subscribeBootstrapChannel,
  bootstrapWithRetry,
  prepareBootstrapWithRetry,
  hydrateBootstrapWithMetrics,
  clearBootstrapPriming,
} = createBootstrapSubscriptionsHelpers({
  redis,
  isRedisOperational,
  query,
  logger,
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
  wsBootstrapIngressKey,
  readWsBootstrapIngressCacheBase,
  writeWsBootstrapIngressCacheBase,
  resolvedWsRuntimeConfig,
  warmWsAclCacheFromChannelList,
  markChannelRecentConnect,
  invalidateRecentConnectTargetsCache,
  subscribeClient,
  subscribeCommunityClient,
  parseChannelKey,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapWallDurationMs,
  bootstrapHydrationScheduler,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_BATCH_SIZE,
});
const { handleClientMessage } = createClientMessageRouter({
  WebSocket,
  logger,
  refreshConnectionTtls,
  isAllowedChannel,
  subscribeBootstrapChannel,
  parseChannelKey,
  unsubscribeCommunityClient,
  unsubscribeClient,
  shouldRefreshOnlinePresence,
  upsertConnectionState,
  recomputeUserPresence,
  presenceService,
});

// ── Heartbeat (server → client WS ping/pong) ──────────────────────────────────
// Uses one global setInterval(WS_HEARTBEAT_INTERVAL_MS). Each tick sets isAlive=false,
// sends ws.ping(); the next tick terminates if no pong arrived. Connect time relative
// to this interval therefore yields *wall-clock* lifetimes between ~heartbeat and
// ~2×heartbeat (e.g. ~20–40s at 20s) — not a fixed 2× from connect unless connects align.
// Missed pongs (slow client, stalled TCP, proxy dropping ping frames, event loop delay)
// produce the same pattern; correlate with ws.disconnected 1006 heartbeat_timeout.
const runtimeIntervals = createRuntimeIntervals({
  wss,
  WebSocket,
  wsHeartbeatIntervalMs: WS_HEARTBEAT_INTERVAL_MS,
  presenceSweeperMs: PRESENCE_SWEEPER_MS,
  noteRecentDisconnectForSocket,
  maybeSendAppKeepaliveFrame,
  reconcileAllConnectedUsers,
  logger,
});

// ── HTTP upgrade handler (attached to http.Server in index.js) ─────────────────
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
}

function getLocalWebSocketClientCount() {
  try {
    return wss.clients.size;
  } catch {
    return 0;
  }
}

const { cleanup } = createDisconnectLifecycle({
  WebSocket,
  clearOutboundQueue,
  wsDisconnectsTotal,
  wsDisconnectReasonTotal,
  wsConnectionLifetimeMs,
  unsubscribeClient,
  unsubscribeCommunityClient,
  noteRecentDisconnectForSocket,
  isRedisOperational,
  redis,
  removeConnection,
  recomputeUserPresence,
  scheduleDebouncedPresenceRecompute,
  logWsHotInfo,
  logger,
  isShuttingDown: () => shuttingDown,
});
const { handleConnection } = createConnectionLifecycle({
  WebSocket,
  randomUUID,
  URL,
  authenticateAccessToken,
  verifyRefresh,
  isAuthBypassEnabled,
  getBypassAuthContext,
  wsConnectionResultTotal,
  logWsHotInfo,
  clientIpFromReq,
  markWsRecentConnect,
  subscribeClient,
  consumeRecentDisconnect,
  observeRecentReconnect,
  isWsReplayDisabled,
  wsReplayFailOpenTotal,
  tryBeginReplayForIp,
  waitForReplayGateOpen,
  getReplayInFlightCount,
  replayAdmissionConfig,
  endReplayForIp,
  tryAcquireReplaySlot,
  canRunReplayForUser,
  replayMissedMessagesToSocket,
  replayPendingMessagesToSocket,
  WS_REPLAY_USER_COOLDOWN_MS,
  releaseReplaySlot,
  noteRecentDisconnectForSocket,
  logger,
  handleClientMessage,
  refreshConnectionTtls,
  upsertConnectionState,
  cancelPendingPresenceRecompute,
  recomputeUserPresence,
  WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS,
  bootstrapWithRetry,
  prepareBootstrapWithRetry,
  hydrateBootstrapWithMetrics,
  clearBootstrapPriming,
  wsReadyWallDurationMs,
  wsBootstrapProgressiveTotal,
  cleanup,
  replayStartupJitterMs,
});

const { shutdown } = createShutdownLifecycle({
  WebSocket,
  wss,
  clearHeartbeatInterval: runtimeIntervals.stopHeartbeat,
  clearPresenceSweepInterval: runtimeIntervals.stopPresenceSweep,
  recordRecentDisconnect,
  recentDisconnectPayloadForSocket,
  removeConnection,
  recomputeUserPresence,
  shutdownCloseGraceMs: WS_SHUTDOWN_CLOSE_GRACE_MS,
  serviceRestartCloseCode: WS_SERVICE_RESTART_CLOSE_CODE,
  serviceRestartCloseReason: WS_SERVICE_RESTART_CLOSE_REASON,
  setShuttingDown: (value) => {
    shuttingDown = value;
  },
});

// ── Connection handling ────────────────────────────────────────────────────────
wss.on("connection", handleConnection);

const { createRedisPubsubDelivery } = require("./redisPubsubDelivery");
const { deliverPubsubMessage } = createRedisPubsubDelivery({
  WebSocket,
  channelClients,
  localUserClients,
  communityClients,
  USER_FEED_SHARD_CHANNEL_SET,
  COMMUNITY_FEED_SHARD_CHANNEL_SET,
  subscribeClient,
  unsubscribeClient,
  subscribeCommunityClient,
  unsubscribeCommunityClient,
  parseChannelKey,
  sendPayloadToSocket,
  fanoutRecipientDedupe,
  wsPartialDeliveryMissingReasonTotal,
  signalLiveFanoutPending: bootstrapHydrationScheduler.signalLiveFanoutPending,
  releaseLiveFanoutPending: bootstrapHydrationScheduler.releaseLiveFanoutPending,
});

bindRedisSubscriber({
  redisSub,
  deliverPubsubMessage,
  logger,
});

module.exports = {
  handleUpgrade,
  wss,
  ready,
  shutdown,
  getLocalWebSocketClientCount,
  invalidateWsBootstrapCache,
  invalidateWsBootstrapCaches,
  invalidateWsAclCache,
  evictUnauthorizedChannelSubscribers,
};
