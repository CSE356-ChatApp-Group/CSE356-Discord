
const crypto = require('crypto');
const { query, poolStats } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const sideEffects = require('./sideEffects');

const MSG_COUNT_RECONCILE_COOLDOWN_SECS = (() => {
  const raw = parseInt(process.env.CHANNEL_MSG_COUNT_RECONCILE_COOLDOWN_SECS || '60', 10);
  if (!Number.isFinite(raw) || raw < 5) return 60;
  return Math.min(3600, raw);
})();

const MSG_COUNT_RECONCILE_LOCK_TTL_MS = (() => {
  const raw = parseInt(process.env.CHANNEL_MSG_COUNT_RECONCILE_LOCK_TTL_MS || '10000', 10);
  if (!Number.isFinite(raw) || raw < 1000) return 10000;
  return Math.min(60000, raw);
})();

const MSG_COUNT_RECONCILE_POOL_WAITING_GUARD = (() => {
  const raw = parseInt(process.env.CHANNEL_MSG_COUNT_RECONCILE_POOL_WAITING_GUARD || '8', 10);
  if (!Number.isFinite(raw) || raw < 0) return 8;
  return Math.min(1000, raw);
})();

/** Redis STRING `channel:msg_count:*` must stay volatile so `maxmemory` + volatile-lru can reclaim idle channels. */
const MSG_COUNT_REDIS_TTL_SECS = (() => {
  const raw = parseInt(process.env.CHANNEL_MSG_COUNT_REDIS_TTL_SECS || '2592000', 10);
  if (!Number.isFinite(raw) || raw < 3600) return 2_592_000;
  return Math.min(86_400 * 90, raw);
})();

const MSG_COUNT_RECONCILE_LOCK_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

function countKeyForChannel(channelId: string) {
  return `channel:msg_count:${channelId}`;
}

function reconcileLockKeyForChannel(channelId: string) {
  return `channel:msg_count:reconcile:lock:${channelId}`;
}

function reconcileCooldownKeyForChannel(channelId: string) {
  return `channel:msg_count:reconcile:cooldown:${channelId}`;
}

async function withReconcileLock(channelId: string, fn: () => Promise<void>) {
  const lockKey = reconcileLockKeyForChannel(channelId);
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const acquired = await redis.set(lockKey, token, 'NX', 'PX', MSG_COUNT_RECONCILE_LOCK_TTL_MS);
  if (acquired !== 'OK') return false;
  try {
    await fn();
  } finally {
    try {
      await redis.eval(MSG_COUNT_RECONCILE_LOCK_RELEASE_LUA, 1, lockKey, token);
    } catch {
      // Best effort lock release; TTL ensures eventual unlock.
    }
  }
  return true;
}

async function reconcileChannelMessageCount(channelId: string) {
  if (poolStats().waiting >= MSG_COUNT_RECONCILE_POOL_WAITING_GUARD) {
    return false;
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS cnt FROM messages WHERE channel_id = $1 AND deleted_at IS NULL`,
    [channelId],
  );
  const count = rows[0]?.cnt ?? 0;
  await redis.set(countKeyForChannel(channelId), String(count), 'EX', MSG_COUNT_REDIS_TTL_SECS);
  return true;
}

async function scheduleCountReconcile(channelId: string) {
  let shouldSchedule = false;
  try {
    const cooldownApplied = await redis.set(
      reconcileCooldownKeyForChannel(channelId),
      '1',
      'NX',
      'EX',
      MSG_COUNT_RECONCILE_COOLDOWN_SECS,
    );
    shouldSchedule = cooldownApplied === 'OK';
  } catch {
    return false;
  }
  if (!shouldSchedule) return false;

  return sideEffects.enqueueFanoutJob('fanout:background.msg_count_reconcile', async () => {
    try {
      await withReconcileLock(channelId, async () => {
        await reconcileChannelMessageCount(channelId);
      });
    } catch (err) {
      logger.warn({ err, channelId }, 'Failed to reconcile channel:msg_count');
    }
  });
}

async function incrementChannelMessageCount(channelId: string) {
  const key = countKeyForChannel(channelId);
  const count = await redis.incr(key);
  await redis.expire(key, MSG_COUNT_REDIS_TTL_SECS).catch(() => {});
  if (count <= 1) {
    scheduleCountReconcile(channelId).catch(() => {});
  }
}

async function decrementChannelMessageCount(channelId: string) {
  const key = countKeyForChannel(channelId);
  const count = await redis.decr(key);
  await redis.expire(key, MSG_COUNT_REDIS_TTL_SECS).catch(() => {});
  if (count < 0) {
    await redis.set(key, '0', 'EX', MSG_COUNT_REDIS_TTL_SECS);
    scheduleCountReconcile(channelId).catch(() => {});
  }
}

module.exports = {
  incrementChannelMessageCount,
  decrementChannelMessageCount,
};
