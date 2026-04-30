/**
 * Communities list cache/version orchestration.
 */

const redis = require("../db/redis");
const { staleCacheKey } = require("../utils/distributedSingleflight");
const {
  PUBLIC_COMMUNITIES_VERSION_KEY,
  communitiesCacheKey,
  communitiesUserVersionKey,
  communitiesLastGoodCacheKey,
} = require("./cacheKeys");

const _communitiesTtl = parseInt(
  process.env.COMMUNITIES_LIST_CACHE_TTL_SECS || "300",
  10,
);
const COMMUNITIES_CACHE_TTL_SECS =
  Number.isFinite(_communitiesTtl) && _communitiesTtl > 0
    ? _communitiesTtl
    : 300;
const _communitiesPagedTtl = parseInt(
  process.env.COMMUNITIES_PAGED_CACHE_TTL_SECS || "60",
  10,
);
const COMMUNITIES_PAGED_CACHE_TTL_SECS =
  Number.isFinite(_communitiesPagedTtl) && _communitiesPagedTtl > 0
    ? _communitiesPagedTtl
    : 60;
const COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS = Math.max(
  COMMUNITIES_CACHE_TTL_SECS,
  900,
);
const _communitiesVersionTtl = parseInt(
  process.env.COMMUNITIES_VERSION_CACHE_TTL_SECS || "2592000",
  10,
);
const COMMUNITIES_VERSION_CACHE_TTL_SECS =
  Number.isFinite(_communitiesVersionTtl) && _communitiesVersionTtl > 0
    ? _communitiesVersionTtl
    : 2_592_000;

/** Unit tests stub `redis` with partial mocks; production ioredis has `expire`. */
async function redisExpireBestEffort(key, ttlSec) {
  if (typeof redis.expire !== "function") return;
  try {
    await redis.expire(key, ttlSec);
  } catch {
    /* ignore */
  }
}

async function invalidateCommunitiesCaches(userIds, publicVersion = "0") {
  const normalizedUserIds = [
    ...new Set(
      (Array.isArray(userIds) ? userIds : []).filter(
        (userId) => typeof userId === "string" && userId,
      ),
    ),
  ];
  const keys = [
    ...new Set(
      normalizedUserIds.flatMap((userId) => {
        const key = communitiesCacheKey(userId, publicVersion);
        return [key, staleCacheKey(key)];
      }),
    ),
  ];
  if (keys.length > 0) {
    await redis.del(...new Set(keys));
  }
  await Promise.allSettled(
    normalizedUserIds.map(async (userId) => {
      const key = communitiesUserVersionKey(userId);
      await redis.incr(key);
      await redisExpireBestEffort(key, COMMUNITIES_VERSION_CACHE_TTL_SECS);
    }),
  );
}

async function getPublicCommunitiesVersion() {
  const v =
    (await redis.get(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => null)) || "0";
  void redisExpireBestEffort(
    PUBLIC_COMMUNITIES_VERSION_KEY,
    COMMUNITIES_VERSION_CACHE_TTL_SECS,
  );
  return v;
}

async function bumpPublicCommunitiesVersion() {
  try {
    await redis.incr(PUBLIC_COMMUNITIES_VERSION_KEY);
    await redisExpireBestEffort(
      PUBLIC_COMMUNITIES_VERSION_KEY,
      COMMUNITIES_VERSION_CACHE_TTL_SECS,
    );
  } catch {
    // Best-effort only.
  }
}

async function getCommunitiesUserVersion(userId) {
  const key = communitiesUserVersionKey(userId);
  const v = (await redis.get(key).catch(() => null)) || "0";
  void redisExpireBestEffort(key, COMMUNITIES_VERSION_CACHE_TTL_SECS);
  return v;
}

async function readLastGoodCommunitiesPayload(userId) {
  try {
    const raw = await redis.get(communitiesLastGoodCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.communities)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeLastGoodCommunitiesPayload(userId, payload) {
  redis
    .setex(
      communitiesLastGoodCacheKey(userId),
      COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS,
      JSON.stringify(payload),
    )
    .catch(() => {});
}

module.exports = {
  _communitiesTtl,
  COMMUNITIES_CACHE_TTL_SECS,
  _communitiesPagedTtl,
  COMMUNITIES_PAGED_CACHE_TTL_SECS,
  COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS,
  _communitiesVersionTtl,
  COMMUNITIES_VERSION_CACHE_TTL_SECS,
  redisExpireBestEffort,
  invalidateCommunitiesCaches,
  getPublicCommunitiesVersion,
  bumpPublicCommunitiesVersion,
  getCommunitiesUserVersion,
  readLastGoodCommunitiesPayload,
  writeLastGoodCommunitiesPayload,
};
