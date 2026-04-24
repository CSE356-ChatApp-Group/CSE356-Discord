'use strict';

function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const { channelAccessCacheTotal } = require('../utils/metrics');
const CH_ACCESS_CACHE_TTL_SECS = parsePositiveIntEnv('CH_ACCESS_CACHE_TTL_SECS', 30);

function channelAccessCacheKey(channelId: string, userId: string): string {
  return `ch_access:${channelId}:${userId}`;
}

async function checkChannelAccessCache(redis: any, channelId: string, userId: string): Promise<boolean> {
  try {
    const val = await redis.get(channelAccessCacheKey(channelId, userId));
    const hit = val === '1';
    channelAccessCacheTotal.inc({ result: hit ? 'hit' : 'miss' });
    return hit;
  } catch {
    return false;
  }
}

function setChannelAccessCache(redis: any, channelId: string, userId: string): void {
  redis.set(channelAccessCacheKey(channelId, userId), '1', 'EX', CH_ACCESS_CACHE_TTL_SECS).catch(() => {});
}

async function warmChannelAccessCacheForUser(redis: any, channelIds: string[], userId: string): Promise<void> {
  if (!channelIds.length) return;
  try {
    const pipeline = redis.pipeline();
    for (const channelId of channelIds) {
      pipeline.set(channelAccessCacheKey(channelId, userId), '1', 'EX', CH_ACCESS_CACHE_TTL_SECS);
    }
    await pipeline.exec();
  } catch {
    await Promise.allSettled(
      channelIds.map((channelId) =>
        redis.set(channelAccessCacheKey(channelId, userId), '1', 'EX', CH_ACCESS_CACHE_TTL_SECS).catch(() => {}),
      ),
    );
  }
}

async function evictChannelAccessCacheForUser(redis: any, channelIds: string[], userId: string): Promise<void> {
  if (!channelIds.length) return;
  try {
    const pipeline = redis.pipeline();
    for (const channelId of channelIds) {
      pipeline.del(channelAccessCacheKey(channelId, userId));
    }
    await pipeline.exec();
  } catch {
    await Promise.allSettled(
      channelIds.map((channelId) =>
        redis.del(channelAccessCacheKey(channelId, userId)).catch(() => {}),
      ),
    );
  }
}

/**
 * Concurrent race: resolves true as soon as either the Redis cache or the
 * provided DB check returns true. Resolves false only when both have returned
 * false (or errored). Fail-open: errors on either side count as false so the
 * race can still be won by the other side.
 */
function raceChannelAccess(
  redis: any,
  channelId: string,
  userId: string,
  dbCheck: () => Promise<boolean>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let pending = 2;
    function onResult(yes: boolean) {
      if (yes) { resolve(true); return; }
      if (--pending === 0) resolve(false);
    }
    checkChannelAccessCache(redis, channelId, userId).then(onResult).catch(() => onResult(false));
    dbCheck().then(onResult).catch(() => onResult(false));
  });
}

module.exports = {
  checkChannelAccessCache,
  setChannelAccessCache,
  warmChannelAccessCacheForUser,
  evictChannelAccessCacheForUser,
  raceChannelAccess,
};
