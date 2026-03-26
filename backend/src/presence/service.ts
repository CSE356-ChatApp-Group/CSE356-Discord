/**
 * Presence service
 *
 * Presence is stored in Redis (TTL-based) as the source of truth for
 * real-time status, with a periodic mirror into Postgres for analytics/history.
 *
 * Redis key:  presence:<userId>   value: 'online' | 'idle' | 'away' | 'offline'
 * TTL:        90 seconds (refreshed by heartbeats from the WS server)
 *
 * When a key expires, the user is effectively 'offline'.
 */

'use strict';

const redis  = require('../db/redis');
const fanout = require('../websocket/fanout');
const { pool } = require('../db/pool');
const overload = require('../utils/overload');

const TTL_SECONDS = 90;

async function setPresence(userId, status) {
  const key = `presence:${userId}`;

  if (status === 'offline') {
    await redis.del(key);
  } else {
    await redis.set(key, status, 'EX', TTL_SECONDS);
  }

  // Under load, preserve explicit away/offline transitions and suppress noisy churn.
  const shouldFanout = !overload.shouldThrottlePresenceFanout() || status === 'away' || status === 'offline';
  if (shouldFanout) {
    await fanout.publish(`user:${userId}`, {
      event: 'presence:updated',
      data:  { userId, status },
    });
  }

  if (!overload.shouldSkipPresenceMirror()) {
    // Mirror to Postgres (non-blocking)
    pool.query(
      `INSERT INTO presence_snapshots (user_id, status, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id) DO UPDATE SET status=$2, updated_at=NOW()`,
      [userId, status]
    ).catch(() => {});
  }
}

async function getPresence(userId) {
  const val = await redis.get(`presence:${userId}`);
  return val || 'offline';
}

async function getBulkPresence(userIds) {
  if (!userIds.length) return {};
  const keys = userIds.map(id => `presence:${id}`);
  const values = await redis.mget(...keys);
  return Object.fromEntries(userIds.map((id, i) => [id, values[i] || 'offline']));
}

module.exports = { setPresence, getPresence, getBulkPresence };
