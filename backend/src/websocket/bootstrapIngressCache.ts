/**
 * Short-lived Redis cache for WS bootstrap ingress coalescing (per user + scope).
 */


function wsBootstrapIngressKey(userId, scope = "default") {
  return `ws:bootstrap:${userId}:ingress:${scope}`;
}

function jitteredIngressTtlSeconds(ttlSeconds) {
  const base = Number.isFinite(ttlSeconds) ? Math.max(1, Math.floor(ttlSeconds)) : 3;
  const jitterMax = Math.max(1, Math.floor(base * 0.2));
  return base + Math.floor(Math.random() * (jitterMax + 1));
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
    // Add a small positive jitter to smooth synchronized expirations during reconnect bursts.
    const ttlWithJitter = jitteredIngressTtlSeconds(ttlSeconds);
    await redis.set(
      wsBootstrapIngressKey(userId, scope),
      JSON.stringify(channels),
      "EX",
      ttlWithJitter,
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
