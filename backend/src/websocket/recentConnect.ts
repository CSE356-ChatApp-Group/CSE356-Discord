'use strict';

const redis = require('../db/redis');

const rawRecentConnectTtl = Number(process.env.WS_RECENT_CONNECT_TTL_SECONDS || '20');
const WS_RECENT_CONNECT_TTL_SECONDS =
  Number.isFinite(rawRecentConnectTtl) && rawRecentConnectTtl > 0
    ? Math.floor(rawRecentConnectTtl)
    : 20;

/** Short-lived key: user had a WebSocket session recently (pending replay enqueue filter). `0` = do not set `ws:replay_pending_eligible:*`. */
const rawReplayRecentWin = Number(process.env.WS_REPLAY_RECENT_USER_WINDOW_SECONDS ?? '30');
const WS_REPLAY_RECENT_USER_WINDOW_SECONDS = (() => {
  if (!Number.isFinite(rawReplayRecentWin)) return 30;
  if (rawReplayRecentWin === 0) return 0;
  if (rawReplayRecentWin >= 5 && rawReplayRecentWin <= 600) return Math.floor(rawReplayRecentWin);
  return 30;
})();

/** When true (default), channel fanout uses per-channel ZSETs instead of O(N) MGET over all members. */
function channelRecentZsetEnabled() {
  return process.env.CHANNEL_RECENT_ZSET_ENABLED !== 'false';
}

function wsRecentConnectKey(userId: string) {
  return `ws:recent_connect:${userId}`;
}

/** Refreshed on each WS connect — used with `WS_REPLAY_PENDING_ONLY_ACTIVE` to avoid Redis pending mailboxes for long-offline users. */
function wsReplayPendingEligibilityKey(userId: string) {
  return `ws:replay_pending_eligible:${userId}`;
}

function channelRecentConnectKey(channelId: string) {
  return `channel:recent_connect:${channelId}`;
}

async function markWsRecentConnect(userId: string) {
  if (WS_REPLAY_RECENT_USER_WINDOW_SECONDS > 0) {
    await redis
      .multi()
      .set(wsRecentConnectKey(userId), '1', 'EX', WS_RECENT_CONNECT_TTL_SECONDS)
      .set(
        wsReplayPendingEligibilityKey(userId),
        '1',
        'EX',
        WS_REPLAY_RECENT_USER_WINDOW_SECONDS,
      )
      .exec();
    return;
  }
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
  WS_REPLAY_RECENT_USER_WINDOW_SECONDS,
  wsRecentConnectKey,
  wsReplayPendingEligibilityKey,
  channelRecentConnectKey,
  channelRecentZsetEnabled,
  markWsRecentConnect,
  markChannelRecentConnect,
};
