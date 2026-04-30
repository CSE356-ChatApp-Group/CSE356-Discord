/**
 * Short-lived Redis cache for WS bootstrap ingress coalescing (per user + scope).
 */


function wsBootstrapIngressKey(userId, scope = "default") {
  return `ws:bootstrap:${userId}:ingress:${scope}`;
}

async function readWsBootstrapIngressCache(redis, isRedisOperational, userId, scope = "default") {
  if (!isRedisOperational(redis)) return null;
  try {
    const raw = await redis.get(wsBootstrapIngressKey(userId, scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value) => typeof value === "string");
  } catch {
    return null;
  }
}

async function writeWsBootstrapIngressCache(
  redis,
  isRedisOperational,
  userId,
  channels,
  ttlSeconds,
  scope = "default",
) {
  if (!isRedisOperational(redis)) return;
  try {
    await redis.set(
      wsBootstrapIngressKey(userId, scope),
      JSON.stringify(channels),
      "EX",
      ttlSeconds,
    );
  } catch {
    /* fail-open */
  }
}

module.exports = {
  wsBootstrapIngressKey,
  readWsBootstrapIngressCache,
  writeWsBootstrapIngressCache,
};
