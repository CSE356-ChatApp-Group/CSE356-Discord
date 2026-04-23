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

"use strict";

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
const presenceService = require("../presence/service");
const { isAuthBypassEnabled, getBypassAuthContext } = require("../auth/bypass");
const { loadReplayableMessagesForUser } = require("../messages/reconnectReplay");
const { markWsRecentConnect, markChannelRecentConnect } = require("./recentConnect");
const { parseReplayAdmissionConfig, evaluateReplayGate } = require("./replayAdmission");
const { isWsReplayDisabled } = require("../utils/abuseKillSwitch");
const { clientIpFromReq } = require("../middleware/wsUpgradeLimiter");
const { isPrivateOrInternalNetwork } = require("../utils/trustedClientIp");
const {
  allUserFeedRedisChannels,
  isUserFeedEnvelope,
  userIdFromTarget,
} = require("./userFeed");
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
  wsReplayFailOpenTotal,
  wsReplayStartedTotal,
  wsReplayConcurrentGauge,
} = require("../utils/metrics");

const wss = new WebSocketServer({ noServer: true });
const IDLE_TTL_SECONDS = 60;
const CONNECTION_ALIVE_TTL_SECONDS = 120;
const PRESENCE_SWEEPER_MS = parseInt(process.env.PRESENCE_SWEEPER_MS || '15000', 10);
// Backpressure thresholds for slow WS consumers.
// DROP: skip this frame if the client's write buffer exceeds 64 KB (except
//   message:* fanout frames — those still send until KILL to avoid silent loss).
//   ~130 typical frames. A client this far behind is already visibly lagging;
//   dropping one frame is better than growing the server-side buffer further.
// KILL: terminate the connection at 2 MB. The client cannot keep up at all;
//   holding 2 MB of queued frames wastes heap and blocks on TCP ACK.
const WS_BACKPRESSURE_DROP_BYTES = parseInt(
  process.env.WS_BACKPRESSURE_DROP_BYTES || String(64 * 1024), 10,
);
const WS_BACKPRESSURE_KILL_BYTES = parseInt(
  process.env.WS_BACKPRESSURE_KILL_BYTES || String(2 * 1024 * 1024), 10,
);
/** Max queued `message:*` frames per socket (never dropped; enqueue waits with setImmediate). */
const WS_OUTBOUND_QUEUE_MAX_MESSAGE = parseInt(
  process.env.WS_OUTBOUND_QUEUE_MAX_MESSAGE || String(512),
  10,
);
/** Max queued best-effort frames per socket (dropped at enqueue when full). */
const WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT = parseInt(
  process.env.WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT || String(128),
  10,
);
/** Max `ws.send` calls per setImmediate drain tick per socket. */
const WS_OUTBOUND_DRAIN_BATCH = parseInt(process.env.WS_OUTBOUND_DRAIN_BATCH || String(32), 10);
/** When primary queue is full, `message:*` jobs wait here (FIFO) until drain makes room. */
const WS_OUTBOUND_MESSAGE_WAITERS_MAX = Math.max(
  64,
  Math.min(
    65536,
    parseInt(process.env.WS_OUTBOUND_MESSAGE_WAITERS_MAX || String(4096), 10) || 4096,
  ),
);
// Skip the sweeper for users whose presence was just recomputed by a real
// event (activity ping, status change, connect/disconnect).  5 s is well
// below the 15 s sweep interval so we never miss an idle transition.
const PRESENCE_SWEEPER_DEBOUNCE_MS = 5_000;
// Tracks the last time recomputeUserPresence ran for each user so the
// reconcile sweeper can skip recently-computed slots.
const lastPresenceComputedAt: Map<string, number> = new Map();
// For clean (1005) disconnects, we debounce the post-disconnect presence
// recompute so that brief reconnects (e.g. grader 30ms cycles) don't cause
// unnecessary offline→online churn. The timeout is cancelled when the user
// reconnects within the debounce window.
const PRESENCE_DISCONNECT_DEBOUNCE_MS = 1_000;
const pendingPresenceRecompute = new Map<string, ReturnType<typeof setTimeout>>();
function cancelPendingPresenceRecompute(userId: string) {
  const t = pendingPresenceRecompute.get(userId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingPresenceRecompute.delete(userId);
  }
}
let shuttingDown = false;

// ── WS ACL in-process cache ────────────────────────────────────────────────────
// Caches the result of isAllowedChannel to avoid a DB round-trip on every
// subscribe message.  Keys are `${userId}:${channel}`.  A 30 s TTL is safe
// because membership changes (join/leave/delete) explicitly call
// invalidateWsAclCache() before the client is notified.
//
// Bursty clients (e.g. automation that spams subscribe) are handled by (1)
// warming this cache from the same list used for auto-bootstrap, and (2)
// coalescing concurrent isAllowedChannel calls for the same key so only one
// DB query runs per cache miss.
const ACL_CACHE_TTL_MS = 30_000;
const _aclRedisTtlSecs = Number(process.env.WS_ACL_REDIS_TTL_SECS || Math.ceil(ACL_CACHE_TTL_MS / 1000));
const WS_ACL_REDIS_TTL_SECS =
  Number.isFinite(_aclRedisTtlSecs) && _aclRedisTtlSecs > 0
    ? Math.floor(_aclRedisTtlSecs)
    : 30;
const aclCache: Map<string, { allowed: boolean; expiresAt: number }> = new Map();
/** In-flight ACL lookups — shared waiters get the same Promise (thundering herd guard). */
const aclCheckInFlight: Map<string, Promise<boolean>> = new Map();
const rawAclCacheMaxEntries = Number(process.env.WS_ACL_CACHE_MAX_ENTRIES || 20_000);
const ACL_CACHE_MAX_ENTRIES =
  Number.isFinite(rawAclCacheMaxEntries) && rawAclCacheMaxEntries > 0
    ? Math.floor(rawAclCacheMaxEntries)
    : 20_000;
const rawBootstrapBatchSize = Number(process.env.WS_BOOTSTRAP_BATCH_SIZE || 96);
const WS_BOOTSTRAP_BATCH_SIZE =
  Number.isFinite(rawBootstrapBatchSize) && rawBootstrapBatchSize > 0
    ? Math.floor(rawBootstrapBatchSize)
    : 96;
const rawRecentDisconnectTtlSeconds = Number(
  process.env.WS_RECENT_DISCONNECT_TTL_SECONDS || 3600,
);
const WS_RECENT_DISCONNECT_TTL_SECONDS =
  Number.isFinite(rawRecentDisconnectTtlSeconds) && rawRecentDisconnectTtlSeconds > 0
    ? Math.floor(rawRecentDisconnectTtlSeconds)
    : 3600;
const rawHeartbeatIntervalMs = Number(process.env.WS_HEARTBEAT_INTERVAL_MS || 20_000);
const WS_HEARTBEAT_INTERVAL_MS =
  Number.isFinite(rawHeartbeatIntervalMs) && rawHeartbeatIntervalMs >= 5_000
    ? Math.floor(rawHeartbeatIntervalMs)
    : 20_000;
const rawAppKeepaliveIntervalMs = Number(process.env.WS_APP_KEEPALIVE_INTERVAL_MS || 0);
const WS_APP_KEEPALIVE_INTERVAL_MS =
  Number.isFinite(rawAppKeepaliveIntervalMs) && rawAppKeepaliveIntervalMs >= 5_000
    ? Math.floor(rawAppKeepaliveIntervalMs)
    : 0;
const WS_APP_KEEPALIVE_FRAME = JSON.stringify({ event: "keepalive" });
const replayAdmissionConfig = parseReplayAdmissionConfig(process.env);
let wsReplayInFlightCount = 0;

/** Concurrent reconnect-replay DB loads per public client IP (hard cap 1). RFC1918/loopback exempt. */
const replayIpConcurrency = new Map();

function isReplayIpExemptFromPerIpCap(ip) {
  return isPrivateOrInternalNetwork(ip);
}

function tryBeginReplayForIp(ip) {
  if (isReplayIpExemptFromPerIpCap(ip)) return true;
  const key = ip || "unknown";
  const n = replayIpConcurrency.get(key) || 0;
  if (n >= 1) return false;
  replayIpConcurrency.set(key, n + 1);
  return true;
}

function endReplayForIp(ip) {
  if (isReplayIpExemptFromPerIpCap(ip)) return;
  const key = ip || "unknown";
  const n = (replayIpConcurrency.get(key) || 0) - 1;
  if (n <= 0) replayIpConcurrency.delete(key);
  else replayIpConcurrency.set(key, n);
}

function replayStartupJitterMs() {
  return 100 + Math.floor(Math.random() * 201);
}

function replayGateSnapshot() {
  const pool = poolStats();
  const gate = evaluateReplayGate(
    Number(pool.waiting || 0),
    wsReplayInFlightCount,
    replayAdmissionConfig,
  );
  return { ...gate, pool };
}

function aclCacheKey(userId: string, channel: string) {
  return `${userId}:${channel}`;
}

function aclRedisCacheKey(userId: string, channel: string) {
  return `ws:acl:${userId}:${channel}`;
}

function parseAclRedisValue(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

function setAclDecisionLocal(userId: string, channel: string, allowed: boolean) {
  const key = aclCacheKey(userId, channel);
  if (aclCache.size >= ACL_CACHE_MAX_ENTRIES) {
    const oldestKey = aclCache.keys().next().value;
    if (oldestKey) aclCache.delete(oldestKey);
  }
  aclCache.set(key, { allowed, expiresAt: Date.now() + ACL_CACHE_TTL_MS });
}

function setAclDecisionShared(userId: string, channel: string, allowed: boolean) {
  if (WS_ACL_REDIS_TTL_SECS <= 0) return;
  redis.set(
    aclRedisCacheKey(userId, channel),
    allowed ? "1" : "0",
    "EX",
    WS_ACL_REDIS_TTL_SECS,
  ).catch(() => {});
}

function setAclDecision(
  userId: string,
  channel: string,
  allowed: boolean,
  opts: { writeShared?: boolean } = {},
) {
  setAclDecisionLocal(userId, channel, allowed);
  if (opts.writeShared !== false) {
    setAclDecisionShared(userId, channel, allowed);
  }
}

async function readAclSharedCacheEntry(userId: string, channel: string): Promise<boolean | null> {
  if (WS_ACL_REDIS_TTL_SECS <= 0) return null;
  try {
    return parseAclRedisValue(await redis.get(aclRedisCacheKey(userId, channel)));
  } catch {
    return null;
  }
}

/** Mark channels as allowed — same membership projection as listAutoSubscriptionChannels. */
function warmWsAclCacheFromChannelList(userId: string, channels: string[]) {
  for (const channel of channels) {
    // Bootstrap warming is local-only to avoid high Redis write volume on reconnect bursts.
    setAclDecision(userId, channel, true, { writeShared: false });
  }
}

function invalidateWsAclCache(userId: string, channel: string) {
  const key = aclCacheKey(userId, channel);
  aclCache.delete(key);
  aclCheckInFlight.delete(key);
  if (WS_ACL_REDIS_TTL_SECS <= 0) return;
  redis.del(aclRedisCacheKey(userId, channel)).catch(() => {});
}

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

// Evict expired entries periodically to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of aclCache) {
    if (v.expiresAt <= now) aclCache.delete(k);
  }
}, 60_000).unref();

function isRedisOperational(client) {
  return ["wait", "connecting", "connect", "ready", "reconnecting"].includes(
    client.status,
  );
}

function connectionSetKey(userId) {
  return `user:${userId}:connections`;
}

function connectionStatusHashKey(userId) {
  return `user:${userId}:connection_status`;
}

function connectionActivityKey(userId, connectionId) {
  return `user:${userId}:connection:${connectionId}:activity`;
}

function connectionAliveKey(userId, connectionId) {
  return `user:${userId}:connection:${connectionId}:alive`;
}

function connectedUsersKey() {
  return "presence:connected_users";
}

function recentDisconnectKey(userId) {
  return `ws:recent_disconnect:${userId}`;
}

function reconnectWindowLabel(gapMs) {
  if (gapMs <= 5_000) return "le_5s";
  if (gapMs <= 30_000) return "le_30s";
  return "le_120s";
}

async function recordRecentDisconnect(userId, payload) {
  if (!isRedisOperational(redis)) return;
  await redis.set(
    recentDisconnectKey(userId),
    JSON.stringify(payload),
    "EX",
    WS_RECENT_DISCONNECT_TTL_SECONDS,
  );
}

function recentDisconnectPayloadForSocket(ws, closeCode = 1005, closeReason = "") {
  const subscriptions = ws?._subscriptions instanceof Set
    ? ws._subscriptions.size
    : Number(ws?._subscriptions?.size || 0) || 0;
  return {
    disconnectedAt: Date.now(),
    closeCode,
    closeReason: closeReason || null,
    bootstrapReady: ws?._bootstrapReady === true,
    lifetimeMs: Math.max(0, Date.now() - Number(ws?._connectedAt || Date.now())),
    sawError: ws?._sawError === true,
    subscriptionCount: subscriptions,
  };
}

function noteRecentDisconnectForSocket(ws, closeCode = 1005, closeReason = "") {
  const userId = typeof ws?._userId === "string" ? ws._userId : null;
  if (!userId) return;
  if (ws._recentDisconnectRecorded === true) return;
  ws._recentDisconnectRecorded = true;
  recordRecentDisconnect(
    userId,
    recentDisconnectPayloadForSocket(ws, closeCode, closeReason),
  ).catch(() => {});
}

async function consumeRecentDisconnect(userId) {
  if (!isRedisOperational(redis)) return null;
  const key = recentDisconnectKey(userId);
  const raw = await redis.get(key);
  if (!raw) return null;

  let previous;
  try {
    previous = JSON.parse(raw);
  } catch {
    await redis.del(key).catch(() => {});
    return null;
  }

  await redis.del(key).catch(() => {});
  return previous;
}

function observeRecentReconnect(userId, connectionId, previous) {
  if (!previous) return;
  const disconnectedAt = Number(previous?.disconnectedAt || 0);
  if (!Number.isFinite(disconnectedAt) || disconnectedAt <= 0) return;

  const gapMs = Math.max(0, Date.now() - disconnectedAt);
  if (gapMs > WS_RECENT_DISCONNECT_TTL_SECONDS * 1000) return;

  wsReconnectsTotal.inc({ window: reconnectWindowLabel(gapMs) });
  wsReconnectGapMs.observe(gapMs);
  logger.info(
    {
      event: "ws.reconnected_after_gap",
      userId,
      connectionId,
      gapMs,
      previousCloseCode: previous?.closeCode ?? null,
      previousBootstrapReady: previous?.bootstrapReady === true,
      previousLifetimeMs: Number(previous?.lifetimeMs || 0) || 0,
    },
    "WS reconnect observed shortly after disconnect",
  );
}

async function replayMissedMessagesToSocket(ws, userId, previousDisconnect, reconnectObservedAtMs) {
  const disconnectedAt = Number(previousDisconnect?.disconnectedAt || 0);
  const reconnectObservedAt = Number(reconnectObservedAtMs || 0);
  if (!Number.isFinite(disconnectedAt) || disconnectedAt <= 0) return;
  if (!Number.isFinite(reconnectObservedAt) || reconnectObservedAt <= disconnectedAt) return;
  if (ws.readyState !== WebSocket.OPEN) return;

  const closeCode: number | undefined = typeof previousDisconnect?.closeCode === 'number'
    ? previousDisconnect.closeCode
    : undefined;

  const messages = await loadReplayableMessagesForUser(
    userId,
    disconnectedAt,
    reconnectObservedAt,
    closeCode,
  );
  if (!messages.length) return;

  logger.info(
    {
      event: "ws.replay.missed_messages",
      userId,
      connectionId: ws._connectionId,
      disconnectedAt,
      reconnectObservedAt,
      replayedMessages: messages.length,
      source: "db",
    },
    "Replaying missed websocket messages after reconnect gap",
  );

  // sendPayloadToSocket enqueues synchronously and drains with setImmediate.
  // bypassLogicalDuplicateSuppression skips only the explicit-channel
  // unsub gate — wasSocketMessageRecentlyDelivered in flushOutboundJob still
  // suppresses replay when the same message id was already delivered live.
  for (const message of messages) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      event: "message:created",
      data: message,
      publishedAt: new Date().toISOString(),
    };
    sendPayloadToSocket(
      ws,
      `user:${userId}`,
      payload,
      null,
      { bypassLogicalDuplicateSuppression: true },
    );
  }
}

async function markConnectionAlive(userId, connectionId) {
  await redis.set(
    connectionAliveKey(userId, connectionId),
    "1",
    "EX",
    CONNECTION_ALIVE_TTL_SECONDS,
  );
}

async function markConnectionActive(userId, connectionId) {
  await redis.set(
    connectionActivityKey(userId, connectionId),
    "1",
    "EX",
    IDLE_TTL_SECONDS,
  );
}

async function refreshConnectionTtls(userId, connectionId, { active = false } = {}) {
  const pipeline = redis.pipeline();
  pipeline.set(
    connectionAliveKey(userId, connectionId),
    "1",
    "EX",
    CONNECTION_ALIVE_TTL_SECONDS,
  );
  if (active) {
    pipeline.set(
      connectionActivityKey(userId, connectionId),
      "1",
      "EX",
      IDLE_TTL_SECONDS,
    );
  }
  await pipeline.exec();
}

function shouldRefreshOnlinePresence(ws) {
  if (ws._presenceStatus !== "online") return true;
  const lastActivityAt = Number(ws._lastActivityAt || 0);
  return !lastActivityAt || Date.now() - lastActivityAt >= IDLE_TTL_SECONDS * 1000;
}

async function upsertConnectionState(userId, connectionId, status) {
  await redis
    .multi()
    .sadd(connectionSetKey(userId), connectionId)
    .sadd(connectedUsersKey(), userId)
    .hset(connectionStatusHashKey(userId), connectionId, status)
    .exec();
}

function resolveAggregateStatus(states) {
  let hasAway = false;
  let hasOnline = false;

  for (const state of states) {
    if (state === "away") hasAway = true;
    else if (state === "online") hasOnline = true;
  }

  if (hasAway) return "away";
  if (hasOnline) return "online";
  return "idle";
}

async function removeConnection(userId, connectionId) {
  await redis
    .multi()
    .srem(connectionSetKey(userId), connectionId)
    .hdel(connectionStatusHashKey(userId), connectionId)
    .del(connectionActivityKey(userId, connectionId))
    .del(connectionAliveKey(userId, connectionId))
    .exec();
}

async function recomputeUserPresence(userId) {
  lastPresenceComputedAt.set(userId, Date.now());
  const connIds = await redis.smembers(connectionSetKey(userId));
  if (!connIds.length) {
    await redis.srem(connectedUsersKey(), userId);
    await presenceService.setPresence(userId, "offline");
    lastPresenceComputedAt.delete(userId); // no longer connected; free the Map entry
    return;
  }

  const statusHash = connectionStatusHashKey(userId);
  const pipeline = redis.pipeline();
  for (const connId of connIds) {
    pipeline.hget(statusHash, connId);
    pipeline.exists(connectionActivityKey(userId, connId));
    pipeline.exists(connectionAliveKey(userId, connId));
  }
  const results = await pipeline.exec();

  const stateByConn = [];
  const staleConnIds = [];
  for (let i = 0; i < connIds.length; i += 1) {
    const statusRes = results[i * 3];
    const activityRes = results[i * 3 + 1];
    const aliveRes = results[i * 3 + 2];
    const connId = connIds[i];

    const status = statusRes?.[1] || "online";
    const isActive = Number(activityRes?.[1] || 0) === 1;
    const isAlive = Number(aliveRes?.[1] || 0) === 1;

    if (!isAlive) {
      staleConnIds.push(connId);
      continue;
    }

    if (status === "away") {
      stateByConn.push("away");
    } else if (status === "idle") {
      stateByConn.push("idle");
    } else {
      if (!isActive) {
        logger.debug({
          event: "presence.activity_expired",
          userId,
          connectionId: connId,
        });
      }
      stateByConn.push(isActive ? "online" : "idle");
    }
  }

  if (staleConnIds.length) {
    const stalePipe = redis.pipeline();
    for (const connId of staleConnIds) {
      stalePipe.srem(connectionSetKey(userId), connId);
      stalePipe.hdel(statusHash, connId);
      stalePipe.del(connectionActivityKey(userId, connId));
      stalePipe.del(connectionAliveKey(userId, connId));
    }
    await stalePipe.exec();
  }

  if (!stateByConn.length) {
    await redis.srem(connectedUsersKey(), userId);
    await presenceService.setPresence(userId, "offline");
    lastPresenceComputedAt.delete(userId); // no longer connected; free the Map entry
    return;
  }

  const aggregateStatus = resolveAggregateStatus(stateByConn);
  if (aggregateStatus === "away") {
    await presenceService.setPresence(userId, "away", undefined);
    return;
  } else {
    await presenceService.setPresence(userId, aggregateStatus, null);
  }
}

async function reconcileAllConnectedUsers() {
  const userIds = await redis.smembers(connectedUsersKey());
  const now = Date.now();
  const stale = userIds.filter((userId) => {
    const last = lastPresenceComputedAt.get(userId) || 0;
    return now - last >= PRESENCE_SWEEPER_DEBOUNCE_MS;
  });

  // Process in parallel with bounded concurrency so the sweeper does not
  // monopolize the event loop when many users are connected.
  const CONCURRENCY = 10;
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    await Promise.allSettled(
      stale.slice(i, i + CONCURRENCY).map((userId) => recomputeUserPresence(userId)),
    );
  }
}

/**
 * Map from Redis channel key → Set of WebSocket clients subscribed to it.
 * This map is LOCAL to this process (node).
 */
const channelClients = new Map(); // key → Set<WebSocket>
const localUserClients = new Map(); // userId → Set<WebSocket>
const WS_SOCKET_MESSAGE_DEDUPE_MAX = 512;

/**
 * Keep track of which Redis channels this process has subscribed to.
 * ioredis re-uses one SUBSCRIBE connection; calling subscribe multiple
 * times for the same channel is a no-op.
 */
const redisSubscribed = new Set();
const redisSubscribeInFlight = new Map();
const USER_FEED_SHARD_CHANNELS = allUserFeedRedisChannels();
const USER_FEED_SHARD_CHANNEL_SET = new Set(USER_FEED_SHARD_CHANNELS);
let wsStartupPromise: Promise<void> | null = null;

// ── Redis subscriber listener ──────────────────────────────────────────────────
function shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed) {
  if (
    !logicalChannel.startsWith("user:")
    || !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return false;
  }

  const ev = (parsed as { event?: unknown }).event;
  if (typeof ev !== "string" || !ev.startsWith("message:")) return false;

  const data = (parsed as {
    data?: {
      channel_id?: string;
      channelId?: string;
      conversation_id?: string;
      conversationId?: string;
    };
  }).data;
  const chId = data?.channel_id || data?.channelId;
  return !!(
    chId
    && (ws as { _explicitChannelUnsub?: Set<string> })._explicitChannelUnsub?.has(`channel:${chId}`)
  );
}

function socketMessageDedupeKey(parsed) {
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    return null;
  }

  const eventName = (parsed as { event?: unknown }).event;
  if (typeof eventName !== "string" || !eventName.startsWith("message:")) {
    return null;
  }

  const data = (parsed as {
    data?: {
      id?: unknown;
      messageId?: unknown;
      message_id?: unknown;
    };
  }).data;
  const messageId = data?.id || data?.messageId || data?.message_id;
  if (typeof messageId !== "string" || !messageId) {
    return null;
  }

  return `${eventName}:${messageId}`;
}

function wasSocketMessageRecentlyDelivered(ws, dedupeKey) {
  if (!dedupeKey) return false;
  const recent = (ws as { _recentMessageKeys?: Map<string, number> })._recentMessageKeys;
  return !!recent?.has(dedupeKey);
}

function markSocketMessageDelivered(ws, dedupeKey) {
  if (!dedupeKey) return;
  if (!(ws as { _recentMessageKeys?: Map<string, number> })._recentMessageKeys) {
    (ws as { _recentMessageKeys?: Map<string, number> })._recentMessageKeys = new Map();
  }
  const recent = (ws as { _recentMessageKeys: Map<string, number> })._recentMessageKeys;
  recent.set(dedupeKey, Date.now());
  while (recent.size > WS_SOCKET_MESSAGE_DEDUPE_MAX) {
    const oldestKey = recent.keys().next().value;
    if (!oldestKey) break;
    recent.delete(oldestKey);
  }
}

function extractInternalUserFeedCommand(payload) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
  ) {
    return null;
  }

  const internal = (payload as { __wsInternal?: unknown }).__wsInternal;
  if (
    !internal
    || typeof internal !== "object"
    || Array.isArray(internal)
    || typeof (internal as { kind?: unknown }).kind !== "string"
  ) {
    return null;
  }

  return internal as { kind: string; channels?: unknown };
}

function prepareSocketPayload(logicalChannel, parsed, rawMessage) {
  const dedupeKey = socketMessageDedupeKey(parsed);
  let payloadEventName;
  let skipDropForBackpressure = false;
  let outbound = rawMessage;
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed)
  ) {
    const ev = (parsed as { event?: unknown }).event;
    if (typeof ev === "string") {
      payloadEventName = ev;
      if (ev.startsWith("message:")) {
        skipDropForBackpressure = true;
      }
    }
    outbound = JSON.stringify({ ...parsed, channel: logicalChannel });
  }

  return { dedupeKey, outbound, payloadEventName, skipDropForBackpressure };
}

function ensureOutboundQueue(ws) {
  if (!(ws as any)._outboundQueue) {
    (ws as any)._outboundQueue = [];
    (ws as any)._outboundDrainScheduled = false;
  }
  if (!(ws as any)._outMsgWaiters) {
    (ws as any)._outMsgWaiters = [];
  }
}

function adjustWsOutboundGauge(delta) {
  if (!delta) return;
  if (delta > 0) {
    wsOutboundQueuedFramesGauge.inc(delta);
  } else {
    wsOutboundQueuedFramesGauge.dec(-delta);
  }
}

function clearOutboundQueue(ws) {
  ensureOutboundQueue(ws);
  const q = (ws as any)._outboundQueue;
  const n = q.length;
  if (n > 0) {
    q.length = 0;
    adjustWsOutboundGauge(-n);
  }
  const waiters = (ws as any)._outMsgWaiters;
  if (waiters && waiters.length) {
    waiters.length = 0;
  }
}

function flushOutboundJob(ws, job) {
  const {
    logicalChannel,
    parsed,
    rawMessage,
    bypassLogicalDuplicateSuppression,
    preparedPayload,
  } = job;
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!bypassLogicalDuplicateSuppression && shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed)) {
    return;
  }

  const resolvedPrepared =
    preparedPayload || prepareSocketPayload(logicalChannel, parsed, rawMessage);
  const {
    dedupeKey,
    outbound,
    payloadEventName,
    skipDropForBackpressure,
  } = resolvedPrepared;
  // Dedupe is independent of bypassLogicalDuplicateSuppression (which only skips
  // user:<self> message:* when the client explicitly unsubscribed the channel).
  // Reconnect replay uses bypass…:true but still hits this check — if live fanout
  // already delivered the same message id, replay is a no-op (correct).
  if (wasSocketMessageRecentlyDelivered(ws, dedupeKey)) return;

  const buffered = (ws as any).bufferedAmount ?? 0;
  if (buffered >= WS_BACKPRESSURE_KILL_BYTES) {
    wsBackpressureEventsTotal.inc({ action: "kill" });
    logger.warn(
      {
        event: "ws.slow_consumer.killed",
        userId: (ws as any)._userId,
        buffered,
        redisChannel: logicalChannel,
        payloadEvent: payloadEventName,
        gradingNote: "correlate_with_failed_deliveries",
      },
      "WS slow consumer: terminating connection due to excessive backpressure",
    );
    noteRecentDisconnectForSocket(ws, 1006, "backpressure_kill");
    clearOutboundQueue(ws);
    ws.terminate();
    return;
  }
  if (!skipDropForBackpressure && buffered >= WS_BACKPRESSURE_DROP_BYTES) {
    wsBackpressureEventsTotal.inc({ action: "drop" });
    logger.warn(
      {
        event: "ws.slow_consumer.frame_dropped",
        userId: (ws as any)._userId,
        buffered,
        redisChannel: logicalChannel,
        payloadEvent: payloadEventName,
        gradingNote: "correlate_with_failed_deliveries",
      },
      "WS slow consumer: dropping frame due to backpressure",
    );
    return;
  }

  markSocketMessageDelivered(ws, dedupeKey);
  ws._lastDataFrameAt = Date.now();
  ws.send(outbound, (err) => {
    if (!err) return;
    (ws as any)._sawError = true;
    logger.warn(
      {
        err,
        event: "ws.send_failed",
        userId: (ws as any)._userId,
        redisChannel: logicalChannel,
        payloadEvent: payloadEventName,
        gradingNote: "correlate_with_failed_deliveries",
      },
      "WS send failed; terminating socket",
    );
    try {
      noteRecentDisconnectForSocket(ws, 1006, "send_failed");
      clearOutboundQueue(ws);
      ws.terminate();
    } catch {
      // Ignore termination failures after send errors.
    }
  });
}

function drainOutboundBatch(ws) {
  ensureOutboundQueue(ws);
  const q = (ws as any)._outboundQueue;
  const waiters = (ws as any)._outMsgWaiters;
  if (ws.readyState !== WebSocket.OPEN) {
    if (waiters.length) {
      waiters.length = 0;
    }
    if (q.length) {
      adjustWsOutboundGauge(-q.length);
      q.length = 0;
    }
    return 0;
  }
  const msgCap =
    Number.isFinite(WS_OUTBOUND_QUEUE_MAX_MESSAGE) && WS_OUTBOUND_QUEUE_MAX_MESSAGE > 0
      ? Math.floor(WS_OUTBOUND_QUEUE_MAX_MESSAGE)
      : 512;
  const batchCap =
    Number.isFinite(WS_OUTBOUND_DRAIN_BATCH) && WS_OUTBOUND_DRAIN_BATCH > 0
      ? Math.min(256, Math.floor(WS_OUTBOUND_DRAIN_BATCH))
      : 32;
  const promoteBudget = Math.max(batchCap * 4, 64);
  let promoted = 0;
  let n = 0;
  while (n < batchCap && ws.readyState === WebSocket.OPEN) {
    while (waiters.length > 0 && q.length < msgCap && promoted < promoteBudget) {
      q.push(waiters.shift());
      adjustWsOutboundGauge(1);
      promoted += 1;
    }
    if (!q.length) break;
    const job = q.shift();
    adjustWsOutboundGauge(-1);
    flushOutboundJob(ws, job);
    n += 1;
  }
  return n;
}

function scheduleOutboundDrain(ws) {
  ensureOutboundQueue(ws);
  if ((ws as any)._outboundDrainScheduled) return;
  const q = (ws as any)._outboundQueue;
  const waiters = (ws as any)._outMsgWaiters;
  const hasWork = q.length > 0 || waiters.length > 0;
  if (!hasWork) return;
  (ws as any)._outboundDrainScheduled = true;
  setImmediate(() => {
    (ws as any)._outboundDrainScheduled = false;
    if (ws.readyState !== WebSocket.OPEN) {
      clearOutboundQueue(ws);
      return;
    }
    const sent = drainOutboundBatch(ws);
    if (sent > 0) {
      wsOutboundDrainBatchesTotal.inc();
    }
    if ((ws as any)._outboundQueue.length > 0 || (ws as any)._outMsgWaiters.length > 0) {
      scheduleOutboundDrain(ws);
    }
  });
}

function sendPayloadToSocket(
  ws,
  logicalChannel,
  parsed,
  rawMessage,
  { bypassLogicalDuplicateSuppression = false, preparedPayload = null } = {},
) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (!bypassLogicalDuplicateSuppression && shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed)) {
    return false;
  }

  const prepared =
    preparedPayload || prepareSocketPayload(logicalChannel, parsed, rawMessage);
  const { dedupeKey, skipDropForBackpressure } = prepared;

  if (wasSocketMessageRecentlyDelivered(ws, dedupeKey)) {
    return false;
  }

  const maxDepth = skipDropForBackpressure
    ? (Number.isFinite(WS_OUTBOUND_QUEUE_MAX_MESSAGE) && WS_OUTBOUND_QUEUE_MAX_MESSAGE > 0
      ? Math.floor(WS_OUTBOUND_QUEUE_MAX_MESSAGE)
      : 512)
    : (Number.isFinite(WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT) && WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT > 0
      ? Math.floor(WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT)
      : 128);

  ensureOutboundQueue(ws);
  const q = (ws as any)._outboundQueue;

  if (skipDropForBackpressure) {
    if (q.length >= maxDepth) {
      const waiters = (ws as any)._outMsgWaiters;
      if (waiters.length >= WS_OUTBOUND_MESSAGE_WAITERS_MAX) {
        wsBackpressureEventsTotal.inc({ action: "kill" });
        logger.warn(
          {
            event: "ws.outbound_waiters_overflow",
            userId: (ws as any)._userId,
            waiters: waiters.length,
            queue: q.length,
            gradingNote: "correlate_with_failed_deliveries",
          },
          "WS outbound: message waiter backlog exceeded hard cap; terminating socket",
        );
        noteRecentDisconnectForSocket(ws, 1006, "outbound_waiters_overflow");
        clearOutboundQueue(ws);
        ws.terminate();
        return false;
      }
      waiters.push({
        logicalChannel,
        parsed,
        rawMessage,
        bypassLogicalDuplicateSuppression,
        preparedPayload: preparedPayload || prepared,
      });
      wsOutboundQueueBlockWaitsTotal.inc();
      scheduleOutboundDrain(ws);
      return true;
    }
  } else if (q.length >= maxDepth) {
    wsOutboundQueueDroppedBestEffortTotal.inc();
    return false;
  }

  q.push({
    logicalChannel,
    parsed,
    rawMessage,
    bypassLogicalDuplicateSuppression,
    preparedPayload: preparedPayload || prepared,
  });
  adjustWsOutboundGauge(1);
  const priority = skipDropForBackpressure ? "message" : "best_effort";
  wsOutboundQueueDepthHistogram.observe({ priority }, q.length);
  scheduleOutboundDrain(ws);
  return true;
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

function recipientClientsForChannel(channel) {
  const userId = userIdFromTarget(channel);
  if (channel.startsWith("user:") && userId) {
    return localUserClients.get(userId) || null;
  }
  return channelClients.get(channel) || null;
}

function deliverUserFeedMessage(channel, routed) {
  const payload = routed.payload;
  const userIds = [...new Set(routed.__wsRoute.userIds.filter((value) => typeof value === "string"))];
  if (!userIds.length) return;

  let recipientCount = 0;
  for (const userId of userIds) {
    recipientCount += localUserClients.get(userId)?.size || 0;
  }
  fanoutRecipientsHistogram.observe({ channel_type: "user" }, recipientCount);

  if (recipientCount === 0 && !logger.isLevelEnabled("debug")) return;

  const internalCommand = extractInternalUserFeedCommand(payload);
  const internalSubscribeChannels = internalCommand?.kind === "subscribe_channels"
    ? [...new Set(
      (Array.isArray(internalCommand.channels) ? internalCommand.channels : [])
        .filter((value) => typeof value === "string")
        .filter((value) => parseChannelKey(value)),
    )]
    : null;

  const payloadEvent = (payload as any)?.event;
  const isMessageEvent = typeof payloadEvent === "string" && payloadEvent.startsWith("message:");
  if (isMessageEvent && logger.isLevelEnabled("debug")) {
    logger.debug(
      {
        channel,
        event: payloadEvent,
        messageId: (payload as any)?.data?.id,
        userIdCount: userIds.length,
        recipientCount,
      },
      recipientCount > 0
        ? "WS userfeed: delivering message to local clients"
        : "WS userfeed: no local clients for message event",
    );
  }

  if (recipientCount === 0) return;

  for (const userId of userIds) {
    const clients = localUserClients.get(userId);
    if (!clients || clients.size === 0) continue;
    const logicalChannel = `user:${userId}`;
    const preparedPayload = prepareSocketPayload(logicalChannel, payload, null);
    for (const ws of clients) {
      if (internalSubscribeChannels) {
        if (!internalSubscribeChannels.length) continue;
        Promise.allSettled(
          internalSubscribeChannels.map((targetChannel) => subscribeClient(ws, targetChannel)),
        ).catch((err) => {
          logger.warn(
            { err, userId, channelCount: internalSubscribeChannels.length },
            "WS internal auto-subscribe command failed",
          );
        });
        continue;
      }

      sendPayloadToSocket(ws, logicalChannel, payload, null, { preparedPayload });
    }
  }
}

function deliverPubsubMessage(channel, message) {
  if (USER_FEED_SHARD_CHANNEL_SET.has(channel)) {
    let routed: unknown = null;
    try {
      routed = JSON.parse(message);
    } catch {
      return;
    }
    if (isUserFeedEnvelope(routed)) {
      deliverUserFeedMessage(channel, routed);
    }
    return;
  }

  const clients = recipientClientsForChannel(channel);
  const recipientCount = clients ? clients.size : 0;
  const channelType = channel.split(":")[0] || "unknown";
  fanoutRecipientsHistogram.observe(
    { channel_type: channelType },
    recipientCount,
  );

  if (!clients || recipientCount === 0) {
    if (!logger.isLevelEnabled("debug")) return;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(message);
  } catch {
  }

  if (channelType === "conversation" && logger.isLevelEnabled("debug")) {
    const parsedEvent = (parsed as any)?.event;
    const isMessageEvent = typeof parsedEvent === "string" && parsedEvent.startsWith("message:");
    if (isMessageEvent) {
      const messageId = (parsed as any)?.data?.id;
      logger.debug(
        { channel, event: parsedEvent, messageId, recipientCount },
        recipientCount > 0
          ? "WS conversation channel: delivering message to subscribers"
          : "WS conversation channel: no subscribers for message event",
      );
    }
  }

  if (!clients || recipientCount === 0) return;

  if (channelType === "user" && recipientCount > 0 && parsed !== null && logger.isLevelEnabled("debug")) {
    logger.debug({
      event: "presence.fanout.delivered",
      channel,
      recipientCount,
      payload: parsed,
    });
  }

  const preparedPayload = prepareSocketPayload(channel, parsed, message);
  let deliveredCount = 0;
  for (const ws of clients) {
    if (sendPayloadToSocket(ws, channel, parsed, message, { preparedPayload })) {
      deliveredCount += 1;
    }
  }
}

redisSub.on("message", (channel, message) => {
  try {
    deliverPubsubMessage(channel, message);
  } catch (err) {
    logger.error({ err, channel }, "deliverPubsubMessage failed");
  }
});

const WS_BOOTSTRAP_CACHE_TTL_SECONDS = parseInt(
  process.env.WS_BOOTSTRAP_CACHE_TTL_SECONDS || '180',
  10,
);
const wsBootstrapListInFlight: Map<string, Promise<string[]>> = new Map();

function wsBootstrapCacheKey(userId, scope = 'full') {
  return `ws:bootstrap:${userId}:${scope}`;
}

/** Invalidate the cached WS subscription list for a user. Call this whenever
 *  their community membership, channel access, or conversation list changes. */
async function invalidateWsBootstrapCache(userId) {
  await invalidateWsBootstrapCaches([userId]);
}

async function invalidateWsBootstrapCaches(userIds) {
  const keys = [];
  const seen = new Set();
  for (const userId of Array.isArray(userIds) ? userIds : []) {
    if (typeof userId !== 'string' || !userId || seen.has(userId)) continue;
    seen.add(userId);
    const messagesKey = wsBootstrapCacheKey(userId, 'messages');
    const fullKey = wsBootstrapCacheKey(userId, 'full');
    keys.push(
      messagesKey,
      staleCacheKey(messagesKey),
      fullKey,
      staleCacheKey(fullKey),
    );
  }
  if (!keys.length) return;
  await redis.del(...keys);
}

function wsAutoSubscribeMode() {
  const mode = String(process.env.WS_AUTO_SUBSCRIBE_MODE || 'messages')
    .trim()
    .toLowerCase();
  if (mode === 'user_only' || mode === 'full') return mode;
  return 'messages';
}

/**
 * Lists every community, channel, and DM for Redis SUBSCRIBE on connect — fine at
 * class scale. If load tests show Redis CPU or pub/sub delivery dominating as
 * membership grows, revisit with aggregated feeds, lazy subscribe, or
 * server-side filtering (phase-2).
 */
async function listAutoSubscriptionChannels(userId, mode = 'full') {
  const scope = mode === 'full' ? 'full' : 'messages';
  const cacheKey = wsBootstrapCacheKey(userId, scope);
  const cached = await getJsonCache(redis, cacheKey);
  if (Array.isArray(cached)) {
    wsBootstrapListCacheTotal.inc({ result: 'hit' });
    wsBootstrapChannelsHistogram.observe(cached.length);
    return cached.filter((value) => typeof value === 'string');
  }

  if (wsBootstrapListInFlight.has(cacheKey)) {
    wsBootstrapListCacheTotal.inc({ result: 'coalesced' });
    const channels = await wsBootstrapListInFlight.get(cacheKey);
    wsBootstrapChannelsHistogram.observe(channels.length);
    return channels;
  }

  wsBootstrapListCacheTotal.inc({ result: 'miss' });
  const load = withDistributedSingleflight({
    redis,
    cacheKey,
    inflight: wsBootstrapListInFlight,
    readFresh: async () => {
      const parsed = await getJsonCache(redis, cacheKey);
      return Array.isArray(parsed) ? parsed : null;
    },
    readStale: async () => {
      const parsed = await getJsonCache(redis, staleCacheKey(cacheKey));
      return Array.isArray(parsed) ? parsed : null;
    },
    load: async () => {
      const [conversationRes, communityRes, channelRes] = await Promise.all([
        query(
          `SELECT conversation_id::text AS id
           FROM conversation_participants
           WHERE user_id = $1 AND left_at IS NULL`,
          [userId],
        ),
        scope === 'full'
          ? query(
            `SELECT community_id::text AS id
             FROM community_members
             WHERE user_id = $1`,
            [userId],
          )
          : Promise.resolve({ rows: [] }),
        query(
          `SELECT c.id::text AS id
           FROM channels c
           JOIN community_members cm
             ON cm.community_id = c.community_id
            AND cm.user_id = $1
           LEFT JOIN channel_members chm
             ON chm.channel_id = c.id
            AND chm.user_id = $1
           WHERE c.is_private = FALSE OR chm.user_id IS NOT NULL`,
          [userId],
        ),
      ]);

      // Subscribe channel topics first so message fanout can arrive before the tail
      // of community/conversation Redis topics finishes (grading: many listeners).
      const channels = [
        ...channelRes.rows.map((row) => `channel:${row.id}`),
        ...conversationRes.rows.map((row) => `conversation:${row.id}`),
        ...communityRes.rows.map((row) => `community:${row.id}`),
      ];
      wsBootstrapChannelsHistogram.observe(channels.length);
      await setJsonCacheWithStale(redis, cacheKey, channels, WS_BOOTSTRAP_CACHE_TTL_SECONDS);
      return channels;
    },
  });
  return load;
}

async function bootstrapUserSubscriptions(ws, userId) {
  const mode = wsAutoSubscribeMode();
  if (mode === 'user_only') return;
  const channels = await listAutoSubscriptionChannels(userId, mode);
  warmWsAclCacheFromChannelList(userId, channels);
  
  // Populate channel:recent_connect ZSETs immediately for all channel: topics
  // before async subscription work begins. This closes a timing gap where
  // users could receive messages on user:<id> but not be in channel ZSETs,
  // causing delivery failures with CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect.
  const channelTopics = channels.filter((ch) => ch.startsWith('channel:'));
  if (channelTopics.length > 0) {
    const zaddPromises = channelTopics.map((channel) => 
      markChannelRecentConnect(userId, channel.slice('channel:'.length)).catch(() => {})
    );
    await Promise.allSettled(zaddPromises);
  }
  
  for (let i = 0; i < channels.length; i += WS_BOOTSTRAP_BATCH_SIZE) {
    const batch = channels.slice(i, i + WS_BOOTSTRAP_BATCH_SIZE);
    await Promise.allSettled(batch.map((channel) => subscribeClient(ws, channel)));
    if (ws.readyState !== WebSocket.OPEN) return;
  }
}

// Retry bootstrap on pool circuit-breaker fires (transient under burst load).
// The connection stays open while we wait; if pool drains within ~3.5s the
// user gets their subscriptions without noticing anything.
async function bootstrapWithRetry(ws, userId, attempt = 0) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (attempt === 0) {
    ws._bootstrapWallStart = Date.now();
  }
  try {
    await bootstrapUserSubscriptions(ws, userId);
    const wallStart = ws._bootstrapWallStart || Date.now();
    const bootstrapWallMs = Date.now() - wallStart;
    wsBootstrapWallDurationMs.observe(bootstrapWallMs);
    if (bootstrapWallMs > 5000) {
      logger.warn({ userId, bootstrapWallMs }, "WS auto-subscribe bootstrap slow");
    }
  } catch (err) {
    const isCircuitOpen = err && err.code === 'POOL_CIRCUIT_OPEN';
    if (isCircuitOpen && attempt < 3) {
      const delayMs = (attempt + 1) * 600; // 600 ms → 1200 ms → 1800 ms
      await new Promise((r) => setTimeout(r, delayMs));
      return bootstrapWithRetry(ws, userId, attempt + 1);
    }
    throw err; // non-retryable or exhausted – caller logs
  }
}

function hasLocalSubscribers(redisChannel) {
  return (channelClients.get(redisChannel)?.size || 0) > 0;
}

async function ensureRedisChannelSubscribed(redisChannel) {
  if (redisSubscribed.has(redisChannel)) return;

  if (redisSubscribeInFlight.has(redisChannel)) {
    await redisSubscribeInFlight.get(redisChannel);
    return;
  }

  if (!isRedisOperational(redisSub)) {
    throw new Error("Redis subscriber is not available");
  }

  const op = Promise.resolve(redisSub.subscribe(redisChannel))
    .then(() => {
      redisSubscribed.add(redisChannel);
    })
    .finally(() => {
      redisSubscribeInFlight.delete(redisChannel);
    });

  redisSubscribeInFlight.set(redisChannel, op);
  await op;
}

async function ensureUserFeedShardSubscriptions() {
  await Promise.all(
    USER_FEED_SHARD_CHANNELS.map((redisChannel) => ensureRedisChannelSubscribed(redisChannel)),
  );
}

function ready() {
  if (!wsStartupPromise) {
    wsStartupPromise = ensureUserFeedShardSubscriptions()
      .then(() => {
        logger.info(
          { shardCount: USER_FEED_SHARD_CHANNELS.length },
          'WS userfeed shard subscriptions ready',
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
  logger.info({ userId: user.id }, "WS connected");
  ws._clientIp = clientIpFromReq(req);
  ws._replayConsumed = false;
  ws._subscriptions = new Set();
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
          logger.info({ userId: user.id }, "WS reconnect replay skipped: DISABLE_WS_REPLAY");
        } else if (ws._replayConsumed === true) {
          wsReplayFailOpenTotal.inc({ reason: "per_socket" });
        } else if (!tryBeginReplayForIp(ws._clientIp)) {
          wsReplayFailOpenTotal.inc({ reason: "per_ip" });
          logger.warn(
            { userId: user.id, clientIp: ws._clientIp },
            "WS reconnect replay skipped: per-IP concurrent replay cap",
          );
        } else {
          const gate = replayGateSnapshot();
          if (!gate.ok) {
            wsReplayFailOpenTotal.inc({ reason: gate.reason || "gate" });
            logger.warn(
              {
                userId: user.id,
                reason: gate.reason,
                waiting: gate.pool.waiting,
                inFlight: wsReplayInFlightCount,
                maxInFlight: replayAdmissionConfig.replaySemaphoreMax,
              },
              "WS reconnect replay skipped: pressure (fail-open empty)",
            );
            endReplayForIp(ws._clientIp);
          } else {
            ws._replayConsumed = true;
            await new Promise((r) => setTimeout(r, replayStartupJitterMs()));
            if (ws.readyState !== WebSocket.OPEN) {
              endReplayForIp(ws._clientIp);
            } else {
              wsReplayInFlightCount += 1;
              wsReplayConcurrentGauge.set(wsReplayInFlightCount);
              wsReplayStartedTotal.inc();
              try {
                await replayMissedMessagesToSocket(
                  ws,
                  user.id,
                  recentDisconnect,
                  replayUpperBoundMs,
                );
              } catch (err) {
                logger.warn({ err, userId: user.id }, "WS reconnect replay failed");
              } finally {
                wsReplayInFlightCount -= 1;
                wsReplayConcurrentGauge.set(wsReplayInFlightCount);
                endReplayForIp(ws._clientIp);
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

  bootstrapWithRetry(ws, user.id)
    .then(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws._lastDataFrameAt = Date.now();
        ws.send(JSON.stringify({ event: 'ready' }));
      }
    })
    .catch((err) => {
      wsConnectionResultTotal.inc({ result: "bootstrap_failed" });
      logger.warn({ err, userId: user.id }, "WS auto-subscribe bootstrap failed");
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
          await subscribeClient(ws, msg.channel);
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
      await unsubscribeClient(ws, msg.channel);
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

// ── Channel allow-list ─────────────────────────────────────────────────────────
function parseChannelKey(channel) {
  if (typeof channel !== "string") return null;
  const match = channel.match(
    /^(channel|conversation|community|user):([\w-]+)$/,
  );
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

async function isAllowedChannel(user, channel) {
  const cacheKey = aclCacheKey(user.id, channel);
  const cached = aclCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.allowed;

  const pending = aclCheckInFlight.get(cacheKey);
  if (pending) return pending;

  const done = (async () => {
    try {
      const sharedCached = await readAclSharedCacheEntry(user.id, channel);
      if (sharedCached !== null) {
        setAclDecision(user.id, channel, sharedCached, { writeShared: false });
        return sharedCached;
      }
      const allowed = await _isAllowedChannelDb(user, channel);
      setAclDecision(user.id, channel, allowed);
      return allowed;
    } finally {
      aclCheckInFlight.delete(cacheKey);
    }
  })();

  aclCheckInFlight.set(cacheKey, done);
  return done;
}

async function _isAllowedChannelDb(user, channel) {
  const parsed = parseChannelKey(channel);
  if (!parsed) return false;

  if (parsed.type === "user") {
    return parsed.id === user.id;
  }

  if (parsed.type === "community") {
    const { rows } = await query(
      `SELECT 1
       FROM community_members
       WHERE community_id = $1 AND user_id = $2`,
      [parsed.id, user.id],
    );
    return rows.length > 0;
  }

  if (parsed.type === "conversation") {
    const { rows } = await query(
      `SELECT 1
       FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [parsed.id, user.id],
    );
    return rows.length > 0;
  }

  const { rows } = await query(
    `SELECT 1
     FROM channels c
     JOIN community_members cm
       ON cm.community_id = c.community_id
      AND cm.user_id = $1
     WHERE c.id = $2
       AND (
         c.is_private = FALSE
         OR EXISTS (
           SELECT 1
           FROM channel_members chm
           WHERE chm.channel_id = c.id
             AND chm.user_id = $1
         )
       )`,
    [user.id, parsed.id],
  );
  return rows.length > 0;
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
    if (redisSubscribed.has(redisChannel) && isRedisOperational(redisSub)) {
      redisSubscribed.delete(redisChannel);
      redisSub.unsubscribe(redisChannel).catch(() => {});
    }
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
    logger.info({ ...logPayload, shuttingDown: true }, "WS disconnected");
    return;
  }

  if (!isRedisOperational(redis)) {
    logger.info({ ...logPayload, redisOperational: false }, "WS disconnected");
    return;
  }

  removeConnection(userId, ws._connectionId)
    .then(() => {
      if (abnormalClose) {
        return recomputeUserPresence(userId);
      }
      // Clean disconnect — debounce presence recompute so short-gap reconnects
      // (grader 30ms cycles) skip the offline→online churn entirely.
      cancelPendingPresenceRecompute(userId);
      const t = setTimeout(() => {
        pendingPresenceRecompute.delete(userId);
        recomputeUserPresence(userId).catch(() => {});
      }, PRESENCE_DISCONNECT_DEBOUNCE_MS);
      t.unref();
      pendingPresenceRecompute.set(userId, t);
    })
    .catch((err) => {
      if (/Connection is closed/i.test(String(err?.message || err))) {
        logger.info(logPayload, "WS disconnected");
        return;
      }
      logger.warn({ err, userId }, "WS cleanup presence update failed");
    });
  if (abnormalClose) {
    logger.warn(logPayload, "WS disconnected abnormally");
  } else {
    logger.info(logPayload, "WS disconnected");
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

async function shutdown() {
  shuttingDown = true;
  clearInterval(heartbeatInterval);
  clearInterval(presenceSweepInterval);

  // Collect all Redis disconnect-record writes before closing connections.
  // noteRecentDisconnectForSocket is fire-and-forget; if we call wss.close()
  // immediately the Redis writes may race against redis.closeRedisConnections()
  // in index.ts, silently dropping the reconnect-replay keys and causing
  // delivery misses when clients reconnect to a new worker.
  const disconnectWrites: Promise<unknown>[] = [];
  wss.clients.forEach((ws) => {
    try {
      const userId = typeof ws?._userId === "string" ? ws._userId : null;
      if (userId && !ws._recentDisconnectRecorded) {
        ws._recentDisconnectRecorded = true;
        disconnectWrites.push(
          recordRecentDisconnect(
            userId,
            recentDisconnectPayloadForSocket(ws, 1001, "shutdown"),
          ).catch(() => {}),
        );
      }
      ws.terminate();
    } catch {
      // Ignore termination errors during shutdown.
    }
  });

  await Promise.allSettled(disconnectWrites);

  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
}

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
