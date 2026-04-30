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
const { authenticateAccessToken } = require("../utils/jwt");
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
  wsConnectionLifetimeMs,
  wsReconnectsTotal,
  wsReconnectGapMs,
  wsBootstrapWallDurationMs,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsReplayFailOpenTotal,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
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
let wsStartupPromise: Promise<void> | null = null;
const {
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
} = createRedisSubscriptionRegistry({
  redisSub,
  isRedisOperational,
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

function maybeSendAppKeepaliveFrame(ws) {
  if (WS_APP_KEEPALIVE_INTERVAL_MS <= 0) return false;
  if (ws.readyState !== WebSocket.OPEN) return false;

  const now = Date.now();
  const lastFrameAt = Number(ws._lastDataFrameAt || ws._connectedAt || 0);
  if (!Number.isFinite(lastFrameAt) || now - lastFrameAt < WS_APP_KEEPALIVE_INTERVAL_MS) {
    return false;
  }

  const buffered = (ws as any).bufferedAmount ?? 0;
  if (buffered >= WS_BACKPRESSURE_DROP_BYTES) {
    return false;
  }

  ws._lastDataFrameAt = now;
  try {
    ws.send(WS_APP_KEEPALIVE_FRAME, (err) => {
      if (!err) return;
      ws._sawError = true;
      logger.warn(
        {
          err,
          event: "ws.keepalive_send_failed",
          userId: (ws as any)._userId,
          gradingNote: "correlate_with_failed_deliveries",
        },
        "WS keepalive send failed; terminating socket",
      );
      try {
        noteRecentDisconnectForSocket(ws, 1006, "keepalive_send_failed");
        ws.terminate();
      } catch {
        // Ignore termination failures after send errors.
      }
    });
    return true;
  } catch (err) {
    ws._sawError = true;
    logger.warn(
      {
        err,
        event: "ws.keepalive_send_failed",
        userId: (ws as any)._userId,
        gradingNote: "correlate_with_failed_deliveries",
      },
      "WS keepalive send failed; terminating socket",
    );
    try {
      noteRecentDisconnectForSocket(ws, 1006, "keepalive_send_failed");
      ws.terminate();
    } catch {
      // Ignore termination failures after send errors.
    }
    return false;
  }
}

const {
  wsBootstrapIngressKey,
  readWsBootstrapIngressCache: readWsBootstrapIngressCacheBase,
  writeWsBootstrapIngressCache: writeWsBootstrapIngressCacheBase,
} = require("./bootstrapIngressCache");
const {
  invalidateWsBootstrapCache,
  invalidateWsBootstrapCaches,
  subscribeBootstrapChannel,
  bootstrapWithRetry,
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
  subscribeClient,
  subscribeCommunityClient,
  parseChannelKey,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapWallDurationMs,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_BATCH_SIZE,
});

async function ensureUserFeedShardSubscriptions() {
  await Promise.all([
    ...USER_FEED_SHARD_CHANNELS.map((redisChannel) => ensureRedisChannelSubscribed(redisChannel)),
    ...COMMUNITY_FEED_SHARD_CHANNELS.map((redisChannel) => ensureRedisChannelSubscribed(redisChannel)),
  ]);
}

function ready() {
  if (!wsStartupPromise) {
    wsStartupPromise = ensureUserFeedShardSubscriptions()
      .then(() => {
        logWsHotInfo(
          () => ({
            userfeedShards: USER_FEED_SHARD_CHANNELS.length,
            communityfeedShards: COMMUNITY_FEED_SHARD_CHANNELS.length,
          }),
          'WS userfeed + communityfeed shard subscriptions ready',
        );
      })
      .catch((err) => {
        wsStartupPromise = null;
        throw err;
      });
  }
  return wsStartupPromise;
}

// ── Connection handling ────────────────────────────────────────────────────────
wss.on("connection", async (ws, req) => {
  // Authenticate
  let user;
  try {
    const url = new URL(req.url, "ws://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      if (!isAuthBypassEnabled()) throw new Error("No token");
      ({ user } = await getBypassAuthContext());
    } else {
      user = await authenticateAccessToken(token);
    }
  } catch {
    wsConnectionResultTotal.inc({ result: "unauthorized" });
    ws.close(4001, "Unauthorized");
    return;
  }

  wsConnectionResultTotal.inc({ result: "accepted" });
  logWsHotInfo(() => ({ userId: user.id }), "WS connected");
  ws._clientIp = clientIpFromReq(req);
  ws._replayConsumed = false;
  ws._subscriptions = new Set();
  ws._communityIds = new Set();
  /** `channel:<uuid>` topics the client explicitly { type: "unsubscribe" }'d — skip duplicate `user:<me>` message:* for those. */
  ws._explicitChannelUnsub = new Set();
  ws._userId = user.id;
  ws._connectionId = randomUUID();
  ws._connectedAt = Date.now();
  ws._lastDataFrameAt = ws._connectedAt;
  ws._bootstrapReady = false;
  ws._presenceStatus = "idle";
  ws._lastActivityAt = 0;
  ws._awayMessage = null;
  ws._sawError = false;
  ws._recentDisconnectRecorded = false;
  ws._recentMessageKeys = new Map();
  ws._outboundQueue = [];
  ws._outboundDrainScheduled = false;

  // Mark freshly connected users for a short window so channel fanout can send
  // a targeted user-topic duplicate while channel auto-subscribe warms up.
  //
  // Ordering: markWsRecentConnect runs immediately; full channel/conversation
  // bootstrap (bootstrapWithRetry → bootstrapUserSubscriptions) runs in parallel
  // and can take seconds for large accounts. During that window the socket is
  // subscribed to user:<id> (below) but not yet to every channel:<id>. Live
  // channel message:created delivery therefore relies on the logical user:<id>
  // duplicate path — in particular CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect
  // is not merely a throughput knob: with that mode, only users in the recent-connect
  // window receive the duplicate; turning it off or mis-tuning it can drop channel
  // messages for sockets still bootstrapping. Default mode=all avoids that coupling.
  markWsRecentConnect(user.id).catch(() => {});

  ws._bootstrapPromise = subscribeClient(ws, `user:${user.id}`)
    .then(async () => {
      // Capture the replay upper bound AFTER the user-topic subscribe completes.
      // This closes the race where messages arriving during subscribe latency (~5-20ms)
      // would be missed by both live delivery (subscribe not yet active) and replay
      // (created_at > upper bound). Capturing now covers the full subscribe gap,
      // at the cost of a few extra DB rows scanned — acceptable given replay limit=60.
      const replayUpperBoundMs = Date.now();
      // Consume the recent-disconnect key AFTER subscribe succeeds, not at
      // connect-start. If we consumed it eagerly and this connection died before
      // bootstrap completed (bootstrapReady:false, lifetimeMs<100ms), the key
      // would be deleted but replay would never fire — the next reconnect attempt
      // would then have no key and silently skip replay.
      const recentDisconnect = await consumeRecentDisconnect(user.id).catch(() => null);
      observeRecentReconnect(user.id, ws._connectionId, recentDisconnect);
      if (recentDisconnect) {
        if (isWsReplayDisabled()) {
          wsReplayFailOpenTotal.inc({ reason: "disabled" });
          logWsHotInfo(() => ({ userId: user.id }), "WS reconnect replay skipped: DISABLE_WS_REPLAY");
        } else if (ws._replayConsumed === true) {
          wsReplayFailOpenTotal.inc({ reason: "per_socket" });
        } else if (!tryBeginReplayForIp(ws._clientIp)) {
          wsReplayFailOpenTotal.inc({ reason: "per_ip" });
          logger.warn(
            { userId: user.id, clientIp: ws._clientIp },
            "WS reconnect replay skipped: per-IP concurrent replay cap",
          );
        } else {
          const admission = await waitForReplayGateOpen(ws, user.id);
          if (!admission.ok) {
            if (!admission.cancelled) {
              wsReplayFailOpenTotal.inc({ reason: admission.gate.reason || "gate" });
            }
            logger.warn(
              {
                userId: user.id,
                reason: admission.gate.reason,
                waiting: admission.gate.pool.waiting,
                inFlight: getReplayInFlightCount(),
                maxInFlight: replayAdmissionConfig.replaySemaphoreMax,
                attempts: admission.attempts,
                deferredWaitMs: admission.totalWaitMs,
                cancelled: admission.cancelled,
              },
              "WS reconnect replay skipped after bounded admission waits",
            );
            endReplayForIp(ws._clientIp);
          } else {
            ws._replayConsumed = true;
            await new Promise((r) => setTimeout(r, replayStartupJitterMs()));
            if (ws.readyState !== WebSocket.OPEN) {
              endReplayForIp(ws._clientIp);
            } else {
              if (!tryAcquireReplaySlot()) {
                wsReplayFailOpenTotal.inc({ reason: "semaphore_full" });
                logger.warn(
                  {
                    userId: user.id,
                    inFlight: getReplayInFlightCount(),
                    maxInFlight: replayAdmissionConfig.replaySemaphoreMax,
                  },
                  "WS reconnect replay skipped: semaphore slot unavailable at execution",
                );
                endReplayForIp(ws._clientIp);
              } else {
                try {
                  const replayStartedAt = Date.now();
                  const replayAllowed = canRunReplayForUser(user.id);
                  if (replayAllowed) {
                    await replayMissedMessagesToSocket(
                      ws,
                      user.id,
                      recentDisconnect,
                      replayUpperBoundMs,
                    );
                  } else {
                    logWsHotInfo(() => ({
                        userId: user.id,
                        connectionId: ws._connectionId,
                        cooldownMs: WS_REPLAY_USER_COOLDOWN_MS,
                      }),
                      "WS reconnect replay DB query skipped due to short per-user cooldown");
                  }
                  const pendingReplayed = await replayPendingMessagesToSocket(ws, user.id);
                  logWsHotInfo(() => ({
                      event: "ws.replay.pending_drain",
                      userId: user.id,
                      connectionId: ws._connectionId,
                      replayAndDrainMs: Date.now() - replayStartedAt,
                      pendingReplayed,
                    }),
                    "WS reconnect replay + pending drain completed before ready");
                } catch (err) {
                  logger.warn({ err, userId: user.id }, "WS reconnect replay failed");
                } finally {
                  releaseReplaySlot();
                  endReplayForIp(ws._clientIp);
                }
              }
            }
          }
        }
      }
      ws._bootstrapReady = true;
    })
    .catch((err) => {
      wsConnectionResultTotal.inc({ result: "user_subscribe_failed" });
      logger.warn({ err, userId: user.id }, "WS user-channel subscribe failed");
      noteRecentDisconnectForSocket(ws, 1011, "user_subscribe_failed");
      ws.close(1011, "Subscription failed");
    });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(ws, user, msg).catch((err) => {
        logger.warn({ err, userId: user.id }, "WS message dispatch failed");
      });
    } catch {
      ws.send(JSON.stringify({ event: "error", data: "Invalid JSON" }));
    }
  });

  ws.on("close", (code, reasonBuffer) => {
    const reason =
      typeof reasonBuffer?.toString === "function" ? reasonBuffer.toString() : "";
    cleanup(ws, user.id, code, reason);
  });

  ws.on("error", (err) => {
    ws._sawError = true;
    logger.warn({ err, userId: user.id }, "WS error");
  });

  // Heartbeat / pong
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
    refreshConnectionTtls(user.id, ws._connectionId).catch(() => {});
    markWsRecentConnect(user.id).catch(() => {});
  });

  ws._presenceInitPromise = upsertConnectionState(user.id, ws._connectionId, "idle")
    .then(async () => {
      // Cancel any debounced disconnect recompute — this connection supersedes it.
      cancelPendingPresenceRecompute(user.id);
      await refreshConnectionTtls(user.id, ws._connectionId, { active: false });
      await recomputeUserPresence(user.id);
    })
    .catch((err) =>
      logger.warn({ err, userId: user.id }, "WS presence setup failed"),
    );

  const bootstrapSubscriptionsPromise = (async () => {
    if (WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * (WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS + 1))),
      );
    }
    return bootstrapWithRetry(ws, user.id);
  })();
  bootstrapSubscriptionsPromise
    .catch((err) => {
      wsConnectionResultTotal.inc({ result: "bootstrap_failed" });
      logger.warn({ err, userId: user.id }, "WS auto-subscribe bootstrap failed");
    });

  Promise.all([ws._bootstrapPromise, bootstrapSubscriptionsPromise])
    .then(() => {
      if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) {
        return;
      }
      // Defensive guard: ensure the personal user feed channel is attached on
      // every connection before advertising subscriptionsHydrated=true.
      // This prevents a reconnect edge where user:<id> could be absent and DM
      // invite/participant events (published via userfeed shards) would miss.
      return subscribeClient(ws, `user:${user.id}`)
        .catch((err) => {
          logger.warn({ err, userId: user.id }, "WS ready guard: user-channel resubscribe failed");
        })
        .then(() => {
          if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) return;
      ws._lastDataFrameAt = Date.now();
      ws.send(
        JSON.stringify({
          event: "ready",
          data: {
            bootstrapComplete: true,
            subscriptionsHydrated: true,
            connectedAt: ws._connectedAt,
            readyAt: ws._lastDataFrameAt,
          },
        }),
      );
        });
    })
    .catch(() => {
    });
});

// ── Client message dispatch ────────────────────────────────────────────────────
async function handleClientMessage(ws, user, msg) {
  if (ws._bootstrapPromise) {
    await ws._bootstrapPromise;
  }
  if (ws._presenceInitPromise) {
    await ws._presenceInitPromise;
  }
  if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) {
    return;
  }

  refreshConnectionTtls(user.id, ws._connectionId).catch(() => {});

  switch (msg.type) {
    case "subscribe": {
      let allowed: boolean;
      try {
        allowed = await isAllowedChannel(user, msg.channel);
      } catch (err) {
        logger.warn({ err, userId: user.id, channel: msg.channel }, "WS subscribe: channel access check failed");
        ws.send(JSON.stringify({ event: "error", data: "Subscribe temporarily unavailable" }));
        break;
      }
      if (allowed) {
        try {
          await subscribeBootstrapChannel(ws, msg.channel);
          ws.send(
            JSON.stringify({
              event: "subscribed",
              data: { channel: msg.channel },
            }),
          );
        } catch {
          ws.send(JSON.stringify({ event: "error", data: "Subscribe failed" }));
        }
      } else {
        ws.send(
          JSON.stringify({ event: "error", data: "Channel not allowed" }),
        );
      }
      break;
    }

    case "unsubscribe":
      if (typeof msg.channel === "string" && msg.channel.startsWith("community:")) {
        const parsed = parseChannelKey(msg.channel);
        if (parsed?.type === "community") unsubscribeCommunityClient(ws, parsed.id);
      } else {
        // Keep user:<self> sticky for this socket; it is the control plane for
        // DM invites/participant updates and bootstrap subscribe commands.
        if (msg.channel === `user:${user.id}`) {
          break;
        }
        await unsubscribeClient(ws, msg.channel);
      }
      break;

    case "ping":
      ws.send(JSON.stringify({ event: "pong" }));
      break;

    case "presence": {
      // Client reporting its own presence status
      if (["online", "idle", "away"].includes(msg.status)) {
        const nextStatus = msg.status;
        const awayMessageChanged =
          nextStatus === "away" && (msg.awayMessage || null) !== (ws._awayMessage || null);
        const redundantOnlineRefresh =
          nextStatus === "online" && !shouldRefreshOnlinePresence(ws);

        if (!awayMessageChanged && nextStatus === ws._presenceStatus && (nextStatus !== "online" || redundantOnlineRefresh)) {
          if (nextStatus === "online") {
            ws._lastActivityAt = Date.now();
            refreshConnectionTtls(user.id, ws._connectionId, { active: true }).catch(() => {});
          }
          break;
        }

        upsertConnectionState(user.id, ws._connectionId, nextStatus)
          .then(async () => {
            ws._presenceStatus = nextStatus;
            if (nextStatus === "away") {
              ws._awayMessage = msg.awayMessage || null;
              await presenceService.setAwayMessage(user.id, msg.awayMessage);
            } else {
              ws._awayMessage = null;
            }
            if (nextStatus === "online") {
              ws._lastActivityAt = Date.now();
              await refreshConnectionTtls(user.id, ws._connectionId, { active: true });
            }
            await recomputeUserPresence(user.id);
          })
          .catch(() => {});
      }
      break;
    }

    case "away_message": {
      const nextAwayMessage = msg.message || null;
      if (nextAwayMessage === (ws._awayMessage || null)) {
        break;
      }

      ws._awayMessage = nextAwayMessage;
      if (ws._presenceStatus === "away") {
        presenceService.setPresence(user.id, "away", nextAwayMessage).catch(() => {});
      } else {
        presenceService.setAwayMessage(user.id, nextAwayMessage).catch(() => {});
      }
      break;
    }

    case "activity": {
      const now = Date.now();
      const needsRefresh = shouldRefreshOnlinePresence(ws);
      refreshConnectionTtls(user.id, ws._connectionId, { active: true })
        .then(async () => {
          ws._lastActivityAt = now;
          if (!needsRefresh) return;
          ws._presenceStatus = "online";
          ws._awayMessage = null;
          await upsertConnectionState(user.id, ws._connectionId, "online");
          await recomputeUserPresence(user.id);
        })
        .catch(() => {});
      break;
    }

    default:
      ws.send(
        JSON.stringify({ event: "error", data: `Unknown type: ${msg.type}` }),
      );
  }
}

// ── Community-feed subscribe helpers ──────────────────────────────────────────
function subscribeCommunityClient(ws, communityId) {
  if (typeof communityId !== "string" || !communityId) return;
  if (!ws._communityIds) ws._communityIds = new Set();
  if (ws._communityIds.has(communityId)) return;
  ws._communityIds.add(communityId);
  if (!communityClients.has(communityId)) {
    communityClients.set(communityId, new Set());
  }
  communityClients.get(communityId).add(ws);
}

function unsubscribeCommunityClient(ws, communityId) {
  if (typeof communityId !== "string" || !communityId) return;
  ws._communityIds?.delete(communityId);
  const clients = communityClients.get(communityId);
  clients?.delete(ws);
  if ((clients?.size || 0) === 0) {
    communityClients.delete(communityId);
  }
}

// ── Subscribe helpers ──────────────────────────────────────────────────────────
async function subscribeClient(ws, redisChannel) {
  if (ws._subscriptions.has(redisChannel)) return;

  const userId = userIdFromTarget(redisChannel);
  if (redisChannel.startsWith("user:") && userId) {
    if (!localUserClients.has(userId)) {
      localUserClients.set(userId, new Set());
    }
    localUserClients.get(userId).add(ws);
    ws._subscriptions.add(redisChannel);
    try {
      await ready();
    } catch (err) {
      const clients = localUserClients.get(userId);
      clients?.delete(ws);
      if ((clients?.size || 0) === 0) {
        localUserClients.delete(userId);
      }
      ws._subscriptions.delete(redisChannel);
      throw err;
    }
    return;
  }

  await ensureRedisChannelSubscribed(redisChannel);

  if (!channelClients.has(redisChannel)) {
    channelClients.set(redisChannel, new Set());
  }
  channelClients.get(redisChannel).add(ws);
  ws._subscriptions.add(redisChannel);
  if (redisChannel.startsWith("channel:")) {
    ws._explicitChannelUnsub?.delete(redisChannel);
    const uid = ws._userId;
    if (uid) {
      markChannelRecentConnect(uid, redisChannel.slice("channel:".length)).catch(() => {});
    }
  }
}

async function unsubscribeClient(ws, redisChannel) {
  const userId = userIdFromTarget(redisChannel);
  if (redisChannel.startsWith("user:") && userId) {
    const clients = localUserClients.get(userId);
    clients?.delete(ws);
    if ((clients?.size || 0) === 0) {
      localUserClients.delete(userId);
    }
    ws._subscriptions.delete(redisChannel);
    return;
  }

  channelClients.get(redisChannel)?.delete(ws);
  ws._subscriptions.delete(redisChannel);
  if (redisChannel.startsWith("channel:")) {
    ws._explicitChannelUnsub?.add(redisChannel);
  }

  if ((channelClients.get(redisChannel)?.size || 0) === 0) {
    channelClients.delete(redisChannel);
    // No local subscribers remain — release the Redis subscription so the
    // subscriber connection doesn't accumulate channels indefinitely.
    releaseRedisChannelSubscription(redisChannel);
  }
}

function cleanup(ws, userId, closeCode = 1005, closeReason = "") {
  clearOutboundQueue(ws);
  const subscriptions = [...ws._subscriptions];
  const bootstrapReady = ws._bootstrapReady === true;
  const lifetimeMs = Math.max(0, Date.now() - Number(ws._connectedAt || Date.now()));
  const clean = closeCode !== 1006;
  const subscriptionCount = subscriptions.length;
  const closeCodeLabel = String(closeCode || 1005);

  wsDisconnectsTotal.inc({
    code: closeCodeLabel,
    clean: clean ? "true" : "false",
    bootstrap_ready: bootstrapReady ? "true" : "false",
  });
  wsConnectionLifetimeMs.observe(
    {
      close_code: closeCodeLabel,
      bootstrap_ready: bootstrapReady ? "true" : "false",
    },
    lifetimeMs,
  );

  Promise.allSettled(
    subscriptions.map((ch) => unsubscribeClient(ws, ch)),
  ).catch(() => {});
  for (const communityId of Array.from(ws._communityIds || [])) {
    unsubscribeCommunityClient(ws, communityId);
  }

  noteRecentDisconnectForSocket(ws, closeCode, closeReason);

  const logPayload = {
    event: "ws.disconnected",
    userId,
    connectionId: ws._connectionId,
    closeCode,
    closeReason: closeReason || null,
    clean,
    bootstrapReady,
    lifetimeMs,
    sawError: ws._sawError === true,
    subscriptionCount,
  };

  const abnormalClose =
    !clean
    || ws._sawError === true
    || closeCode === 1011
    || closeCode === 4001;

  if (shuttingDown) {
    logWsHotInfo(() => ({ ...logPayload, shuttingDown: true }), "WS disconnected");
    return;
  }

  if (!isRedisOperational(redis)) {
    logWsHotInfo(() => ({ ...logPayload, redisOperational: false }), "WS disconnected");
    return;
  }

  removeConnection(userId, ws._connectionId)
    .then(() => {
      if (abnormalClose) {
        return recomputeUserPresence(userId);
      }
      // Clean disconnect — debounce presence recompute so short-gap reconnects
      // (grader 30ms cycles) skip the offline→online churn entirely.
      scheduleDebouncedPresenceRecompute(userId);
    })
    .catch((err) => {
      if (/Connection is closed/i.test(String(err?.message || err))) {
        logWsHotInfo(() => logPayload, "WS disconnected");
        return;
      }
      logger.warn({ err, userId }, "WS cleanup presence update failed");
    });
  if (abnormalClose) {
    logger.warn(logPayload, "WS disconnected abnormally");
  } else {
    logWsHotInfo(() => logPayload, "WS disconnected");
  }
}

// ── Heartbeat (server → client WS ping/pong) ──────────────────────────────────
// Uses one global setInterval(WS_HEARTBEAT_INTERVAL_MS). Each tick sets isAlive=false,
// sends ws.ping(); the next tick terminates if no pong arrived. Connect time relative
// to this interval therefore yields *wall-clock* lifetimes between ~heartbeat and
// ~2×heartbeat (e.g. ~20–40s at 20s) — not a fixed 2× from connect unless connects align.
// Missed pongs (slow client, stalled TCP, proxy dropping ping frames, event loop delay)
// produce the same pattern; correlate with ws.disconnected 1006 heartbeat_timeout.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      noteRecentDisconnectForSocket(ws, 1006, "heartbeat_timeout");
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
    maybeSendAppKeepaliveFrame(ws);
  });
}, WS_HEARTBEAT_INTERVAL_MS);

// Periodically reconcile global user presence from client-reported connection state.
const presenceSweepInterval = setInterval(() => {
  reconcileAllConnectedUsers().catch((err) => {
    logger.warn({ err }, "Presence sweeper failed");
  });
}, PRESENCE_SWEEPER_MS);

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

function waitForSocketClose(ws, timeoutMs) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    ws.once("close", finish);
  });
}

async function shutdown() {
  shuttingDown = true;
  clearInterval(heartbeatInterval);
  clearInterval(presenceSweepInterval);

  // Collect all Redis disconnect-record writes and connection cleanup before
  // closing the shared clients in index.ts.  During deploys, terminating
  // sockets without cleanup leaves short-lived stale connection-set entries;
  // pending replay then sees SCARD > 0 and can skip offline users.
  // noteRecentDisconnectForSocket is fire-and-forget; if we call wss.close()
  // immediately the Redis writes may race against redis.closeRedisConnections()
  // in index.ts, silently dropping the reconnect-replay keys and causing
  // delivery misses when clients reconnect to a new worker.
  const disconnectWrites: Promise<unknown>[] = [];
  const cleanupWrites: Promise<unknown>[] = [];
  const usersToRecompute = new Set();
  const closeWaits: Promise<unknown>[] = [];

  wss.clients.forEach((ws) => {
    try {
      const userId = typeof ws?._userId === "string" ? ws._userId : null;
      const connectionId = typeof ws?._connectionId === "string" ? ws._connectionId : null;
      if (userId && !ws._recentDisconnectRecorded) {
        ws._recentDisconnectRecorded = true;
        disconnectWrites.push(
          recordRecentDisconnect(
            userId,
            recentDisconnectPayloadForSocket(
              ws,
              WS_SERVICE_RESTART_CLOSE_CODE,
              WS_SERVICE_RESTART_CLOSE_REASON,
            ),
          ).catch(() => {}),
        );
      }
      if (userId && connectionId) {
        usersToRecompute.add(userId);
        cleanupWrites.push(removeConnection(userId, connectionId).catch(() => {}));
      }

      if (ws.readyState === WebSocket.OPEN) {
        closeWaits.push(waitForSocketClose(ws, WS_SHUTDOWN_CLOSE_GRACE_MS));
        ws.close(WS_SERVICE_RESTART_CLOSE_CODE, WS_SERVICE_RESTART_CLOSE_REASON);
      } else if (ws.readyState === WebSocket.CLOSING) {
        closeWaits.push(waitForSocketClose(ws, WS_SHUTDOWN_CLOSE_GRACE_MS));
      } else if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    } catch {
      // Ignore socket errors during shutdown.
    }
  });

  await Promise.allSettled([...disconnectWrites, ...cleanupWrites]);
  await Promise.allSettled(
    Array.from(usersToRecompute).map((userId) => recomputeUserPresence(userId).catch(() => {})),
  );

  await Promise.allSettled(closeWaits);
  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.terminate();
      } catch {
        // Ignore termination errors during shutdown.
      }
    }
  });

  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
}

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
});

redisSub.on("message", (channel, message) => {
  void deliverPubsubMessage(channel, message).catch((err) => {
    logger.error({ err, channel }, "deliverPubsubMessage failed");
  });
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
