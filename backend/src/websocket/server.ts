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
 * Phase 2 (heavier fan-out) — engineering note
 * --------------------------------------------
 * Today each browser subscribes to many Redis channels (per DM, per community
 * channel, per user inbox). Under large guilds + many open DMs, pub/sub fan-in
 * and per-socket delivery become the bottleneck before Postgres.
 *
 * Planned mitigations (not all implemented here):
 *   • Collapse subscriptions: e.g. one “bootstrap” stream per user plus targeted
 *     refetches instead of N parallel channel topics.
 *   • Aggregate presence/notifications server-side before WS push.
 *   • Prefer server-initiated delta sync when backpressure fires instead of
 *     unbounded frame queues.
 *
 * SLO / UX stance for backpressure (current implementation):
 *   • **Drop** (buffer > WS_BACKPRESSURE_DROP_BYTES): best-effort — client may
 *     miss an ephemeral frame; acceptable for presence-style traffic if clients
 *     reconcile via REST or a periodic sync.
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
const { query } = require("../db/pool");
const logger = require("../utils/logger");
const presenceService = require("../presence/service");
const { isAuthBypassEnabled, getBypassAuthContext } = require("../auth/bypass");
const {
  fanoutRecipientsHistogram,
  wsConnectionResultTotal,
  wsBackpressureEventsTotal,
} = require("../utils/metrics");
const { tracer, context, trace } = require("../utils/tracer");

const wss = new WebSocketServer({ noServer: true });
const IDLE_TTL_SECONDS = 60;
const CONNECTION_ALIVE_TTL_SECONDS = 120;
const PRESENCE_SWEEPER_MS = 15_000;
// Backpressure thresholds for slow WS consumers.
// DROP: skip this frame if the client's write buffer exceeds 64 KB.
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
// Skip the sweeper for users whose presence was just recomputed by a real
// event (activity ping, status change, connect/disconnect).  5 s is well
// below the 15 s sweep interval so we never miss an idle transition.
const PRESENCE_SWEEPER_DEBOUNCE_MS = 5_000;
// Tracks the last time recomputeUserPresence ran for each user so the
// reconcile sweeper can skip recently-computed slots.
const lastPresenceComputedAt: Map<string, number> = new Map();
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
const aclCache: Map<string, { allowed: boolean; expiresAt: number }> = new Map();
/** In-flight ACL lookups — shared waiters get the same Promise (thundering herd guard). */
const aclCheckInFlight: Map<string, Promise<boolean>> = new Map();
const rawAclCacheMaxEntries = Number(process.env.WS_ACL_CACHE_MAX_ENTRIES || 20_000);
const ACL_CACHE_MAX_ENTRIES =
  Number.isFinite(rawAclCacheMaxEntries) && rawAclCacheMaxEntries > 0
    ? Math.floor(rawAclCacheMaxEntries)
    : 20_000;
const rawBootstrapBatchSize = Number(process.env.WS_BOOTSTRAP_BATCH_SIZE || 50);
const WS_BOOTSTRAP_BATCH_SIZE =
  Number.isFinite(rawBootstrapBatchSize) && rawBootstrapBatchSize > 0
    ? Math.floor(rawBootstrapBatchSize)
    : 50;

function aclCacheKey(userId: string, channel: string) {
  return `${userId}:${channel}`;
}

function storeAclCacheEntry(userId: string, channel: string, allowed: boolean) {
  const key = aclCacheKey(userId, channel);
  if (aclCache.size >= ACL_CACHE_MAX_ENTRIES) {
    const oldestKey = aclCache.keys().next().value;
    if (oldestKey) aclCache.delete(oldestKey);
  }
  aclCache.set(key, { allowed, expiresAt: Date.now() + ACL_CACHE_TTL_MS });
}

/** Mark channels as allowed — same membership projection as listAutoSubscriptionChannels. */
function warmWsAclCacheFromChannelList(userId: string, channels: string[]) {
  for (const channel of channels) {
    storeAclCacheEntry(userId, channel, true);
  }
}

function invalidateWsAclCache(userId: string, channel: string) {
  aclCache.delete(aclCacheKey(userId, channel));
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
  let idleSpan = null;
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
        // Start a root span that will parent the fanout spans below
        if (!idleSpan) {
          idleSpan = tracer.startSpan("presence.idle_transition", {
            attributes: { userId, connectionId: connId },
          });
        }
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
    idleSpan?.end();
    return;
  }

  const aggregateStatus = resolveAggregateStatus(stateByConn);
  if (aggregateStatus === "away") {
    await presenceService.setPresence(userId, "away", undefined);
    return;
  } else {
    if (idleSpan) {
      idleSpan.setAttribute("resolved_status", aggregateStatus);
      // Run setPresence inside the span's context so fanout spans are children
      const ctx = trace.setSpan(context.active(), idleSpan);
      await context.with(ctx, () =>
        presenceService.setPresence(userId, aggregateStatus, null),
      );
      idleSpan.end();
    } else {
      // online
      await presenceService.setPresence(userId, aggregateStatus, null);
    }
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

/**
 * Keep track of which Redis channels this process has subscribed to.
 * ioredis re-uses one SUBSCRIBE connection; calling subscribe multiple
 * times for the same channel is a no-op.
 */
const redisSubscribed = new Set();
const redisSubscribeInFlight = new Map();

// ── Redis subscriber listener ──────────────────────────────────────────────────
function deliverPubsubMessage(channel, message) {
  const clients = channelClients.get(channel);
  const recipientCount = clients ? clients.size : 0;

  // Record recipient distribution by channel type (user / channel / conversation)
  const channelType = channel.split(":")[0] || "unknown";
  fanoutRecipientsHistogram.observe(
    { channel_type: channelType },
    recipientCount,
  );

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(message);
  } catch {
    // non-JSON payload — deliver raw string below
  }

  // Keep this at debug level to avoid log floods during high presence churn.
  if (channelType === "user" && recipientCount > 0 && parsed !== null) {
    logger.debug({
      event: "presence.fanout.delivered",
      channel,
      recipientCount,
      payload: parsed,
    });
  }

  if (!clients || recipientCount === 0) return;

  let outbound = message;
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed)
  ) {
    outbound = JSON.stringify({ ...parsed, channel });
  }

  clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buffered: number = (ws as any).bufferedAmount ?? 0;
    if (buffered >= WS_BACKPRESSURE_KILL_BYTES) {
      wsBackpressureEventsTotal.inc({ action: "kill" });
      logger.warn(
        { event: 'ws.slow_consumer.killed', userId: (ws as any)._userId, buffered },
        'WS slow consumer: terminating connection due to excessive backpressure',
      );
      ws.terminate();
      return;
    }
    if (buffered >= WS_BACKPRESSURE_DROP_BYTES) {
      wsBackpressureEventsTotal.inc({ action: "drop" });
      logger.warn(
        { event: 'ws.slow_consumer.frame_dropped', userId: (ws as any)._userId, buffered },
        'WS slow consumer: dropping frame due to backpressure',
      );
      return;
    }
    ws.send(outbound);
  });
}

redisSub.on("message", (channel, message) => {
  deliverPubsubMessage(channel, message);
});

const WS_BOOTSTRAP_CACHE_TTL_SECONDS = parseInt(
  process.env.WS_BOOTSTRAP_CACHE_TTL_SECONDS || '30',
  10,
);

function wsBootstrapCacheKey(userId) {
  return `ws:bootstrap:${userId}`;
}

/** Invalidate the cached WS subscription list for a user. Call this whenever
 *  their community membership, channel access, or conversation list changes. */
async function invalidateWsBootstrapCache(userId) {
  await redis.del(wsBootstrapCacheKey(userId));
}

/**
 * Lists every community, channel, and DM for Redis SUBSCRIBE on connect — fine at
 * class scale. If load tests show Redis CPU or pub/sub delivery dominating as
 * membership grows, revisit with aggregated feeds, lazy subscribe, or
 * server-side filtering (phase-2).
 */
async function listAutoSubscriptionChannels(userId) {
  const cacheKey = wsBootstrapCacheKey(userId);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      await redis.del(cacheKey);
    }
  }

  const [conversationRes, communityRes, channelRes] = await Promise.all([
    query(
      `SELECT conversation_id::text AS id
       FROM conversation_participants
       WHERE user_id = $1 AND left_at IS NULL`,
      [userId],
    ),
    query(
      `SELECT community_id::text AS id
       FROM community_members
       WHERE user_id = $1`,
      [userId],
    ),
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

  const channels = [
    ...conversationRes.rows.map((row) => `conversation:${row.id}`),
    ...communityRes.rows.map((row) => `community:${row.id}`),
    ...channelRes.rows.map((row) => `channel:${row.id}`),
  ];

  // Cache for a short TTL. Invalidated explicitly on membership changes.
  redis
    .set(cacheKey, JSON.stringify(channels), 'EX', WS_BOOTSTRAP_CACHE_TTL_SECONDS)
    .catch(() => {}); // fire-and-forget, non-critical

  return channels;
}

async function bootstrapUserSubscriptions(ws, userId) {
  const channels = await listAutoSubscriptionChannels(userId);
  warmWsAclCacheFromChannelList(userId, channels);
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
  try {
    await bootstrapUserSubscriptions(ws, userId);
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
  ws._subscriptions = new Set();
  ws._userId = user.id;
  ws._connectionId = randomUUID();
  ws._bootstrapReady = false;
  ws._presenceStatus = "idle";
  ws._lastActivityAt = 0;
  ws._awayMessage = null;

  ws._bootstrapPromise = subscribeClient(ws, `user:${user.id}`)
    .then(() => {
      ws._bootstrapReady = true;
    })
    .catch((err) => {
      wsConnectionResultTotal.inc({ result: "user_subscribe_failed" });
      logger.warn({ err, userId: user.id }, "WS user-channel subscribe failed");
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

  ws.on("close", () => {
    cleanup(ws, user.id);
  });

  ws.on("error", (err) => {
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
      await refreshConnectionTtls(user.id, ws._connectionId, { active: false });
      await recomputeUserPresence(user.id);
    })
    .catch((err) =>
      logger.warn({ err, userId: user.id }, "WS presence setup failed"),
    );

  bootstrapWithRetry(ws, user.id)
    .then(() => {
      if (ws.readyState === WebSocket.OPEN) {
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
    case "subscribe":
      if (await isAllowedChannel(user, msg.channel)) {
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
      const allowed = await _isAllowedChannelDb(user, channel);
      storeAclCacheEntry(user.id, channel, allowed);
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

  await ensureRedisChannelSubscribed(redisChannel);

  if (!channelClients.has(redisChannel)) {
    channelClients.set(redisChannel, new Set());
  }
  channelClients.get(redisChannel).add(ws);
  ws._subscriptions.add(redisChannel);
}

async function unsubscribeClient(ws, redisChannel) {
  channelClients.get(redisChannel)?.delete(ws);
  ws._subscriptions.delete(redisChannel);

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

function cleanup(ws, userId) {
  const subscriptions = [...ws._subscriptions];
  Promise.allSettled(
    subscriptions.map((ch) => unsubscribeClient(ws, ch)),
  ).catch(() => {});

  if (shuttingDown) {
    logger.info({ userId }, "WS disconnected");
    return;
  }

  if (!isRedisOperational(redis)) {
    logger.info({ userId }, "WS disconnected");
    return;
  }

  removeConnection(userId, ws._connectionId)
    .then(() => recomputeUserPresence(userId))
    .catch((err) => {
      if (/Connection is closed/i.test(String(err?.message || err))) {
        logger.info({ userId }, "WS disconnected");
        return;
      }
      logger.warn({ err, userId }, "WS cleanup presence update failed");
    });
  logger.info({ userId }, "WS disconnected");
}

// ── Heartbeat loop (60 s) ──────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 60_000);

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

function shutdown() {
  shuttingDown = true;
  clearInterval(heartbeatInterval);
  clearInterval(presenceSweepInterval);

  return new Promise<void>((resolve) => {
    wss.clients.forEach((ws) => {
      try {
        ws.terminate();
      } catch {
        // Ignore termination errors during shutdown.
      }
    });

    wss.close(() => resolve());
  });
}

module.exports = { handleUpgrade, wss, shutdown, invalidateWsBootstrapCache, invalidateWsAclCache };
