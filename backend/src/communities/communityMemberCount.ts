'use strict';

/**
 * Async community member_count maintenance.
 *
 * Hot path (join/leave): HINCRBY community:counts <id> ±1 in Redis (sub-ms).
 * Background (every ~5 min): batch UPDATE communities SET member_count = COUNT(*)
 * for dirty entries, then sync Redis with the authoritative DB values.
 *
 * Redis keys:
 *   community:counts          — HASH field=communityId, value=count
 *   community:counts:dirty    — SET of communityIds touched since last reconcile
 *   community:counts:reconcile:lock — distributed lock for background reconcile
 */

const { query, poolStats } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const {
  communityCountRedisUpdateTotal,
  communityCountPgReconcileTotal,
  communityCountPgReconcileSkippedTotal,
  communityCountCacheTotal,
} = require('../utils/metrics');

const COMMUNITY_COUNTS_KEY = 'community:counts';
const COMMUNITY_COUNTS_DIRTY_KEY = 'community:counts:dirty';
const COMMUNITY_COUNT_RECONCILE_LOCK_KEY = 'community:counts:reconcile:lock';

const COMMUNITY_COUNT_RECONCILE_INTERVAL_MS = parseInt(
  process.env.COMMUNITY_COUNT_RECONCILE_INTERVAL_MS || '300000', 10,
);
const COMMUNITY_COUNT_RECONCILE_BATCH_SIZE = Math.min(
  200,
  Math.max(10, parseInt(process.env.COMMUNITY_COUNT_RECONCILE_BATCH_SIZE || '100', 10) || 100),
);
const COMMUNITY_COUNT_RECONCILE_LOCK_TTL_MS = Math.max(
  COMMUNITY_COUNT_RECONCILE_INTERVAL_MS,
  parseInt(process.env.COMMUNITY_COUNT_RECONCILE_LOCK_TTL_MS || '90000', 10) || 90000,
);
const COMMUNITY_COUNT_RECONCILE_PRESSURE_QUEUE = parseInt(
  process.env.COMMUNITY_COUNT_RECONCILE_PRESSURE_QUEUE || '2', 10,
);

let localReconcileInFlight = false;

const RECONCILE_SQL = `
  WITH counts AS (
    SELECT community_id, COUNT(*)::int AS cnt
    FROM community_members
    WHERE community_id = ANY($1::uuid[])
    GROUP BY community_id
  )
  UPDATE communities c
  SET member_count = COALESCE(counts.cnt, 0)
  FROM (SELECT unnest($1::uuid[]) AS id) ids
  LEFT JOIN counts ON counts.community_id = ids.id
  WHERE c.id = ids.id
  RETURNING c.id::text AS id, c.member_count
`;

async function acquireReconcileLock(): Promise<string | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  try {
    const acquired = await redis.set(
      COMMUNITY_COUNT_RECONCILE_LOCK_KEY,
      token,
      'PX',
      COMMUNITY_COUNT_RECONCILE_LOCK_TTL_MS,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  } catch {
    return null;
  }
}

async function releaseReconcileLock(token: string): Promise<void> {
  try {
    await redis.eval(
      `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) end return 0`,
      1,
      COMMUNITY_COUNT_RECONCILE_LOCK_KEY,
      token,
    );
  } catch {
    // ignore
  }
}

/**
 * Fire-and-forget: increment member_count for communityId in Redis.
 * Marks communityId dirty for background reconcile.
 */
async function incrCommunityMemberCount(communityId: string): Promise<void> {
  try {
    await redis
      .pipeline()
      .hincrby(COMMUNITY_COUNTS_KEY, communityId, 1)
      .sadd(COMMUNITY_COUNTS_DIRTY_KEY, communityId)
      .exec();
    communityCountRedisUpdateTotal.inc({ result: 'ok' });
  } catch (err: any) {
    communityCountRedisUpdateTotal.inc({ result: 'error' });
    logger.warn({ err, communityId }, 'communityMemberCount: Redis incr failed');
  }
}

/**
 * Fire-and-forget: decrement member_count for communityId in Redis, clamped to 0.
 * Marks communityId dirty for background reconcile.
 */
async function decrCommunityMemberCount(communityId: string): Promise<void> {
  try {
    const results = await redis
      .pipeline()
      .hincrby(COMMUNITY_COUNTS_KEY, communityId, -1)
      .sadd(COMMUNITY_COUNTS_DIRTY_KEY, communityId)
      .exec();
    const [[incrErr, newVal]] = results;
    if (!incrErr && typeof newVal === 'number' && newVal < 0) {
      await redis.hset(COMMUNITY_COUNTS_KEY, communityId, '0');
    }
    communityCountRedisUpdateTotal.inc({ result: 'ok' });
  } catch (err: any) {
    communityCountRedisUpdateTotal.inc({ result: 'error' });
    logger.warn({ err, communityId }, 'communityMemberCount: Redis decr failed');
  }
}

/**
 * Read member counts for a batch of community IDs from Redis.
 * Returns a Map<communityId, count>; missing entries are absent (caller uses DB value).
 */
async function getCommunityMemberCountsFromRedis(
  communityIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!communityIds.length) return result;
  try {
    const values: (string | null)[] = await redis.hmget(COMMUNITY_COUNTS_KEY, ...communityIds);
    for (let i = 0; i < communityIds.length; i++) {
      const raw = values[i];
      if (raw !== null && raw !== undefined) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) {
          result.set(communityIds[i], Math.max(0, n));
          communityCountCacheTotal.inc({ result: 'hit' });
        } else {
          communityCountCacheTotal.inc({ result: 'miss' });
        }
      } else {
        communityCountCacheTotal.inc({ result: 'miss' });
      }
    }
  } catch (err: any) {
    logger.warn({ err }, 'communityMemberCount: Redis HMGET failed');
    // return empty map — callers fall back to DB member_count column
  }
  return result;
}

async function runReconcile(): Promise<void> {
  if (localReconcileInFlight) return;
  localReconcileInFlight = true;

  let lockToken: string | null = null;
  try {
    const stats = poolStats();
    if (stats.waiting >= COMMUNITY_COUNT_RECONCILE_PRESSURE_QUEUE) {
      communityCountPgReconcileSkippedTotal.inc({ reason: 'pressure' });
      return;
    }

    lockToken = await acquireReconcileLock();
    if (!lockToken) {
      communityCountPgReconcileSkippedTotal.inc({ reason: 'lock' });
      return;
    }

    let dirtyIds: string[];
    try {
      if (typeof redis.sscan === 'function') {
        const scanResult = await redis.sscan(
          COMMUNITY_COUNTS_DIRTY_KEY,
          '0',
          'COUNT',
          COMMUNITY_COUNT_RECONCILE_BATCH_SIZE * 2,
        );
        dirtyIds = Array.isArray(scanResult) && Array.isArray(scanResult[1]) ? scanResult[1] : [];
      } else {
        dirtyIds = await redis.smembers(COMMUNITY_COUNTS_DIRTY_KEY);
      }
    } catch {
      return;
    }

    if (dirtyIds.length === 0) {
      communityCountPgReconcileSkippedTotal.inc({ reason: 'empty' });
      return;
    }

    for (let i = 0; i < dirtyIds.length; i += COMMUNITY_COUNT_RECONCILE_BATCH_SIZE) {
      const batch = dirtyIds.slice(i, i + COMMUNITY_COUNT_RECONCILE_BATCH_SIZE);
      try {
        const { rows } = await query(RECONCILE_SQL, [batch]);

        // Sync Redis with authoritative DB values from RETURNING
        if (rows.length > 0) {
          const pipeline = redis.pipeline();
          for (const row of rows) {
            pipeline.hset(COMMUNITY_COUNTS_KEY, row.id, String(row.member_count));
          }
          await pipeline.exec();
        }

        if (batch.length === 1) {
          await redis.srem(COMMUNITY_COUNTS_DIRTY_KEY, batch[0]);
        } else {
          await redis.srem(COMMUNITY_COUNTS_DIRTY_KEY, ...batch);
        }
        communityCountPgReconcileTotal.inc({ result: 'ok' });
      } catch (err: any) {
        communityCountPgReconcileTotal.inc({ result: 'error' });
        logger.warn({ err, batchSize: batch.length }, 'communityMemberCount: reconcile batch failed');
      }
    }
  } finally {
    if (lockToken) await releaseReconcileLock(lockToken);
    localReconcileInFlight = false;
  }
}

function startCommunityCountReconcileInterval(
  intervalMs: number = COMMUNITY_COUNT_RECONCILE_INTERVAL_MS,
): void {
  setInterval(() => { runReconcile().catch(() => {}); }, intervalMs).unref();
}

module.exports = {
  incrCommunityMemberCount,
  decrCommunityMemberCount,
  getCommunityMemberCountsFromRedis,
  runReconcile,
  startCommunityCountReconcileInterval,
};
