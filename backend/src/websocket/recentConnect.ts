'use strict';

const redis = require('../db/redis');

const rawRecentConnectTtl = Number(process.env.WS_RECENT_CONNECT_TTL_SECONDS || '20');
const WS_RECENT_CONNECT_TTL_SECONDS =
  Number.isFinite(rawRecentConnectTtl) && rawRecentConnectTtl > 0
    ? Math.floor(rawRecentConnectTtl)
    : 20;

function wsRecentConnectKey(userId: string) {
  return `ws:recent_connect:${userId}`;
}

async function markWsRecentConnect(userId: string) {
  await redis.set(wsRecentConnectKey(userId), '1', 'EX', WS_RECENT_CONNECT_TTL_SECONDS);
}

module.exports = {
  WS_RECENT_CONNECT_TTL_SECONDS,
  wsRecentConnectKey,
  markWsRecentConnect,
};
