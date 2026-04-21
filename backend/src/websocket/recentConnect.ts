'use strict';

const redis = require('../db/redis');

const rawRecentConnectTtl = Number(process.env.WS_RECENT_CONNECT_TTL_SECONDS || '20');
const WS_RECENT_CONNECT_TTL_SECONDS =
  Number.isFinite(rawRecentConnectTtl) && rawRecentConnectTtl > 0
    ? Math.floor(rawRecentConnectTtl)
    : 20;

/** When true (default), channel fanout uses per-channel ZSETs instead of O(N) MGET over all members. */
function channelRecentZsetEnabled() {
  return process.env.CHANNEL_RECENT_ZSET_ENABLED !== 'false';
}

function wsRecentConnectKey(userId: string) {
  return `ws:recent_connect:${userId}`;
}

function channelRecentConnectKey(channelId: string) {
  return `channel:recent_connect:${channelId}`;
}

async function markWsRecentConnect(userId: string) {
  await redis.set(wsRecentConnectKey(userId), '1', 'EX', WS_RECENT_CONNECT_TTL_SECONDS);
}

/**
 * Record that this user recently subscribed to a channel (WebSocket `channel:<id>`).
 * Prunes stale scores, refreshes key TTL — used by channel fanout ZRANGEBYSCORE instead of MGET.
 */
async function markChannelRecentConnect(userId: string, channelId: string) {
  if (!channelRecentZsetEnabled()) return;
  const key = channelRecentConnectKey(channelId);
  const now = Date.now();
  const cutoff = now - WS_RECENT_CONNECT_TTL_SECONDS * 1000 - 1000;
  await redis
    .multi()
    .zremrangebyscore(key, '-inf', cutoff)
    .zadd(key, now, userId)
    .expire(key, WS_RECENT_CONNECT_TTL_SECONDS + 60)
    .exec();
}

module.exports = {
  WS_RECENT_CONNECT_TTL_SECONDS,
  wsRecentConnectKey,
  channelRecentConnectKey,
  channelRecentZsetEnabled,
  markWsRecentConnect,
  markChannelRecentConnect,
};
