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

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccess }  = require('../utils/jwt');
const { redisSub }      = require('../db/redis');
const logger            = require('../utils/logger');
const presenceService   = require('../presence/service');
const { isAuthBypassEnabled, getBypassAuthContext } = require('../auth/bypass');

const wss = new WebSocketServer({ noServer: true });

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

// ── Redis subscriber listener ──────────────────────────────────────────────────
redisSub.on('message', (channel, message) => {
  const clients = channelClients.get(channel);
  if (!clients || clients.size === 0) return;

  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message); // already serialized JSON
    }
  });
});

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

  // Mark user online
  presenceService.setPresence(user.id, 'online').catch(() => {});

  // Automatically subscribe to personal notification channel
  subscribeClient(ws, `user:${user.id}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(ws, user, msg);
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
  ws.on('pong', () => { ws.isAlive = true; });
});

// ── Client message dispatch ────────────────────────────────────────────────────
function handleClientMessage(ws, user, msg) {
  switch (msg.type) {
    case 'subscribe':
      if (isAllowedChannel(user, msg.channel)) {
        subscribeClient(ws, msg.channel);
        ws.send(JSON.stringify({ event: 'subscribed', data: { channel: msg.channel } }));
      } else {
        ws.send(JSON.stringify({ event: 'error', data: 'Channel not allowed' }));
      }
      break;

    case 'unsubscribe':
      unsubscribeClient(ws, msg.channel);
      break;

    case 'ping':
      ws.send(JSON.stringify({ event: 'pong' }));
      break;

    case 'presence':
      // Client reporting its own presence status
      if (['online', 'idle', 'away'].includes(msg.status)) {
        presenceService.setPresence(user.id, msg.status).catch(() => {});
      }
      break;

    default:
      ws.send(JSON.stringify({ event: 'error', data: `Unknown type: ${msg.type}` }));
  }
}

// ── Channel allow-list ─────────────────────────────────────────────────────────
// In production, verify the user is a member of the channel/conversation/community.
// Here we allow any well-formed channel key for MVP simplicity.
function isAllowedChannel(_user, channel) {
  return /^(channel|conversation|community|user):[\w-]+$/.test(channel);
}

// ── Subscribe helpers ──────────────────────────────────────────────────────────
function subscribeClient(ws, redisChannel) {
  if (!channelClients.has(redisChannel)) {
    channelClients.set(redisChannel, new Set());
  }
  channelClients.get(redisChannel).add(ws);
  ws._subscriptions.add(redisChannel);

  if (!redisSubscribed.has(redisChannel)) {
    redisSubscribed.add(redisChannel);
    redisSub.subscribe(redisChannel);
  }
}

function unsubscribeClient(ws, redisChannel) {
  channelClients.get(redisChannel)?.delete(ws);
  ws._subscriptions.delete(redisChannel);
}

function cleanup(ws, userId) {
  ws._subscriptions.forEach((ch) => {
    channelClients.get(ch)?.delete(ws);
  });
  presenceService.setPresence(userId, 'offline').catch(() => {});
  logger.info({ userId }, 'WS disconnected');
}

// ── Heartbeat loop (60 s) ──────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 60_000);

// ── HTTP upgrade handler (attached to http.Server in index.js) ─────────────────
function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

module.exports = { handleUpgrade, wss };
