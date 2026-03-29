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
 */

'use strict';

const { randomUUID } = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccess }  = require('../utils/jwt');
const redis             = require('../db/redis');
const { redisSub }      = require('../db/redis');
const { pool }          = require('../db/pool');
const logger            = require('../utils/logger');
const presenceService   = require('../presence/service');
const { isAuthBypassEnabled, getBypassAuthContext } = require('../auth/bypass');

const wss = new WebSocketServer({ noServer: true });
const IDLE_TTL_SECONDS = 60;
const CONNECTION_ALIVE_TTL_SECONDS = 120;
const PRESENCE_SWEEPER_MS = 15_000;
let shuttingDown = false;

function isRedisOperational(client) {
  return ['wait', 'connecting', 'connect', 'ready', 'reconnecting'].includes(client.status);
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
  return 'presence:connected_users';
}

async function markConnectionAlive(userId, connectionId) {
  await redis.set(connectionAliveKey(userId, connectionId), '1', 'EX', CONNECTION_ALIVE_TTL_SECONDS);
}

async function markConnectionActive(userId, connectionId) {
  await redis.set(connectionActivityKey(userId, connectionId), '1', 'EX', IDLE_TTL_SECONDS);
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
    if (state === 'away') hasAway = true;
    else if (state === 'online') hasOnline = true;
  }

  if (hasAway) return 'away';
  if (hasOnline) return 'online';
  return 'idle';
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
  const connIds = await redis.smembers(connectionSetKey(userId));
  if (!connIds.length) {
    await redis.srem(connectedUsersKey(), userId);
    await presenceService.setPresence(userId, 'offline');
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

    const status = statusRes?.[1] || 'online';
    const isActive = Number(activityRes?.[1] || 0) === 1;
    const isAlive = Number(aliveRes?.[1] || 0) === 1;

    if (!isAlive) {
      staleConnIds.push(connId);
      continue;
    }

    if (status === 'away') {
      stateByConn.push('away');
    } else if (status === 'idle') {
      stateByConn.push('idle');
    } else {
      stateByConn.push(isActive ? 'online' : 'idle');
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
    await presenceService.setPresence(userId, 'offline');
    return;
  }

  const aggregateStatus = resolveAggregateStatus(stateByConn);
  if (aggregateStatus === 'away') {
    await presenceService.setPresence(userId, 'away', undefined);
    return;
  }
  await presenceService.setPresence(userId, aggregateStatus, null);
}

async function reconcileAllConnectedUsers() {
  const userIds = await redis.smembers(connectedUsersKey());
  for (const userId of userIds) {
    await recomputeUserPresence(userId);
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
redisSub.on('message', (channel, message) => {
  const clients = channelClients.get(channel);
  if (!clients || clients.size === 0) return;

  let outbound = message;
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      outbound = JSON.stringify({ ...parsed, channel });
    }
  } catch {
    // Keep original payload if it is not valid JSON.
  }

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(outbound);
    }
  });
});

async function listAutoSubscriptionChannels(userId) {
  const [conversationRes, communityRes, channelRes] = await Promise.all([
    pool.query(
      `SELECT conversation_id::text AS id
       FROM conversation_participants
       WHERE user_id = $1 AND left_at IS NULL`,
      [userId]
    ),
    pool.query(
      `SELECT community_id::text AS id
       FROM community_members
       WHERE user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT c.id::text AS id
       FROM channels c
       JOIN community_members cm
         ON cm.community_id = c.community_id
        AND cm.user_id = $1
       LEFT JOIN channel_members chm
         ON chm.channel_id = c.id
        AND chm.user_id = $1
       WHERE c.is_private = FALSE OR chm.user_id IS NOT NULL`,
      [userId]
    ),
  ]);

  return [
    ...conversationRes.rows.map((row) => `conversation:${row.id}`),
    ...communityRes.rows.map((row) => `community:${row.id}`),
    ...channelRes.rows.map((row) => `channel:${row.id}`),
  ];
}

async function bootstrapUserSubscriptions(ws, userId) {
  const channels = await listAutoSubscriptionChannels(userId);
  await Promise.allSettled(channels.map((channel) => subscribeClient(ws, channel)));
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
    throw new Error('Redis subscriber is not available');
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
wss.on('connection', async (ws, req) => {
  // Authenticate
  let user;
  try {
    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      if (!isAuthBypassEnabled()) throw new Error('No token');
      ({ user } = await getBypassAuthContext());
    } else {
      user = verifyAccess(token);
    }
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  logger.info({ userId: user.id }, 'WS connected');
  ws._subscriptions = new Set();
  ws._userId = user.id;
  ws._connectionId = randomUUID();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(ws, user, msg).catch((err) => {
        logger.warn({ err, userId: user.id }, 'WS message dispatch failed');
      });
    } catch {
      ws.send(JSON.stringify({ event: 'error', data: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    cleanup(ws, user.id);
  });

  ws.on('error', (err) => {
    logger.warn({ err, userId: user.id }, 'WS error');
  });

  // Heartbeat / pong
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
    markConnectionAlive(user.id, ws._connectionId).catch(() => {});
  });

  upsertConnectionState(user.id, ws._connectionId, 'idle')
    .then(async () => {
      await markConnectionAlive(user.id, ws._connectionId);
      await recomputeUserPresence(user.id);
    })
    .catch((err) => logger.warn({ err, userId: user.id }, 'WS presence setup failed'));

  // Automatically subscribe to personal notification channel without blocking
  // client message handling, otherwise early subscribe frames can be dropped.
  subscribeClient(ws, `user:${user.id}`)
    .catch((err) => logger.warn({ err, userId: user.id }, 'WS user-channel subscribe failed'));

  bootstrapUserSubscriptions(ws, user.id)
    .catch((err) => logger.warn({ err, userId: user.id }, 'WS auto-subscribe bootstrap failed'));
});

// ── Client message dispatch ────────────────────────────────────────────────────
async function handleClientMessage(ws, user, msg) {
  markConnectionAlive(user.id, ws._connectionId).catch(() => {});

  switch (msg.type) {
    case 'subscribe':
      if (await isAllowedChannel(user, msg.channel)) {
        try {
          await subscribeClient(ws, msg.channel);
          ws.send(JSON.stringify({ event: 'subscribed', data: { channel: msg.channel } }));
        } catch {
          ws.send(JSON.stringify({ event: 'error', data: 'Subscribe failed' }));
        }
      } else {
        ws.send(JSON.stringify({ event: 'error', data: 'Channel not allowed' }));
      }
      break;

    case 'unsubscribe':
      await unsubscribeClient(ws, msg.channel);
      break;

    case 'ping':
      ws.send(JSON.stringify({ event: 'pong' }));
      break;

    case 'presence':
      // Client reporting its own presence status
      if (['online', 'idle', 'away'].includes(msg.status)) {
        upsertConnectionState(user.id, ws._connectionId, msg.status)
          .then(async () => {
            if (msg.status === 'away') {
              await presenceService.setAwayMessage(user.id, msg.awayMessage);
            }
            await recomputeUserPresence(user.id);
          })
          .catch(() => {});
      }
      break;

    case 'activity':
      markConnectionActive(user.id, ws._connectionId)
        .then(() => upsertConnectionState(user.id, ws._connectionId, 'online'))
        .then(() => recomputeUserPresence(user.id))
        .catch(() => {});
      break;

    default:
      ws.send(JSON.stringify({ event: 'error', data: `Unknown type: ${msg.type}` }));
  }
}

// ── Channel allow-list ─────────────────────────────────────────────────────────
function parseChannelKey(channel) {
  if (typeof channel !== 'string') return null;
  const match = channel.match(/^(channel|conversation|community|user):([\w-]+)$/);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

async function isAllowedChannel(user, channel) {
  const parsed = parseChannelKey(channel);
  if (!parsed) return false;

  if (parsed.type === 'user') {
    return parsed.id === user.id;
  }

  if (parsed.type === 'community') {
    const { rows } = await pool.query(
      `SELECT 1
       FROM community_members
       WHERE community_id = $1 AND user_id = $2`,
      [parsed.id, user.id]
    );
    return rows.length > 0;
  }

  if (parsed.type === 'conversation') {
    const { rows } = await pool.query(
      `SELECT 1
       FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [parsed.id, user.id]
    );
    return rows.length > 0;
  }

  const { rows } = await pool.query(
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
    [user.id, parsed.id]
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
  }
}

function cleanup(ws, userId) {
  const subscriptions = [...ws._subscriptions];
  Promise.allSettled(subscriptions.map((ch) => unsubscribeClient(ws, ch))).catch(() => {});

  if (shuttingDown) {
    logger.info({ userId }, 'WS disconnected');
    return;
  }

  if (!isRedisOperational(redis)) {
    logger.info({ userId }, 'WS disconnected');
    return;
  }

  removeConnection(userId, ws._connectionId)
    .then(() => recomputeUserPresence(userId))
    .catch((err) => {
      if (/Connection is closed/i.test(String(err?.message || err))) {
        logger.info({ userId }, 'WS disconnected');
        return;
      }
      logger.warn({ err, userId }, 'WS cleanup presence update failed');
    });
  logger.info({ userId }, 'WS disconnected');
}

// ── Heartbeat loop (60 s) ──────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 60_000);

// Periodically reconcile global user presence from client-reported connection state.
const presenceSweepInterval = setInterval(() => {
  reconcileAllConnectedUsers().catch((err) => {
    logger.warn({ err }, 'Presence sweeper failed');
  });
}, PRESENCE_SWEEPER_MS);

// ── HTTP upgrade handler (attached to http.Server in index.js) ─────────────────
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
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

module.exports = { handleUpgrade, wss, shutdown };
