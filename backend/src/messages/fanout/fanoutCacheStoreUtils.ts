const redis = require('../../db/redis');

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

async function invalidateVersionedCache(cacheKey: string, versionKey: string) {
  try {
    const p = redis.pipeline();
    p.del(cacheKey);
    p.incr(versionKey);
    await p.exec();
  } catch {
    await redis.del(cacheKey).catch(() => {});
    await redis.incr(versionKey).catch(() => {});
  }
}

module.exports = {
  readVersionedCacheState,
  invalidateVersionedCache,
};

