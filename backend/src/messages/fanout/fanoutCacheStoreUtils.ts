const redis = require('../../db/redis');
const FANOUT_CACHE_VERSION_KEY_TTL_SECS = (() => {
  const raw = Number.parseInt(process.env.FANOUT_CACHE_VERSION_KEY_TTL_SECS || '2592000', 10);
  if (!Number.isFinite(raw) || raw < 60) return 2_592_000;
  return Math.min(raw, 60 * 60 * 24 * 90);
})();

async function readVersionedCacheState(cacheKey: string, versionKey: string) {
  const mget = typeof redis.mget === 'function' ? redis.mget.bind(redis) : null;
  if (!mget) {
    const [cached, version] = await Promise.all([
      redis.get(cacheKey).catch(() => null),
      redis.get(versionKey).catch(() => null),
    ]);
    return { cached, version };
  }

  try {
    const [cached, version] = await mget(cacheKey, versionKey);
    return { cached: cached || null, version: version || null };
  } catch {
    const [cached, version] = await Promise.all([
      redis.get(cacheKey).catch(() => null),
      redis.get(versionKey).catch(() => null),
    ]);
    return { cached, version };
  }
}

async function invalidateVersionedCache(
  cacheKey: string,
  versionKey: string,
  versionTtlSecs: number = FANOUT_CACHE_VERSION_KEY_TTL_SECS,
) {
  const normalizedVersionTtlSecs = Number.isFinite(versionTtlSecs) && versionTtlSecs > 0
    ? Math.floor(versionTtlSecs)
    : FANOUT_CACHE_VERSION_KEY_TTL_SECS;
  try {
    const p = redis.pipeline();
    p.del(cacheKey);
    p.incr(versionKey);
    p.expire(versionKey, normalizedVersionTtlSecs);
    await p.exec();
  } catch {
    await Promise.allSettled([
      redis.del(cacheKey),
      redis.incr(versionKey),
      redis.expire(versionKey, normalizedVersionTtlSecs),
    ]);
  }
}

module.exports = {
  readVersionedCacheState,
  invalidateVersionedCache,
};

