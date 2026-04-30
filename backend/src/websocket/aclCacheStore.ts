function createWsAclCacheStore({
  redis,
  aclCacheTtlMs,
  aclCacheMaxEntries,
  wsAclRedisTtlSecs,
}) {
  const aclCache = new Map();
  const aclCheckInFlight = new Map();

  function aclCacheKey(userId: string, channel: string) {
    return `${userId}:${channel}`;
  }

  function aclRedisCacheKey(userId: string, channel: string) {
    return `ws:acl:${userId}:${channel}`;
  }

  function parseAclRedisValue(raw: string | null): boolean | null {
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  }

  function setAclDecisionLocal(userId: string, channel: string, allowed: boolean) {
    const key = aclCacheKey(userId, channel);
    if (aclCache.size >= aclCacheMaxEntries) {
      const oldestKey = aclCache.keys().next().value;
      if (oldestKey) aclCache.delete(oldestKey);
    }
    aclCache.set(key, { allowed, expiresAt: Date.now() + aclCacheTtlMs });
  }

  function setAclDecisionShared(userId: string, channel: string, allowed: boolean) {
    if (wsAclRedisTtlSecs <= 0) return;
    redis.set(
      aclRedisCacheKey(userId, channel),
      allowed ? "1" : "0",
      "EX",
      wsAclRedisTtlSecs,
    ).catch(() => {});
  }

  function setAclDecision(
    userId: string,
    channel: string,
    allowed: boolean,
    opts: { writeShared?: boolean } = {},
  ) {
    setAclDecisionLocal(userId, channel, allowed);
    if (opts.writeShared !== false) {
      setAclDecisionShared(userId, channel, allowed);
    }
  }

  async function readAclSharedCacheEntry(userId: string, channel: string): Promise<boolean | null> {
    if (wsAclRedisTtlSecs <= 0) return null;
    try {
      return parseAclRedisValue(await redis.get(aclRedisCacheKey(userId, channel)));
    } catch {
      return null;
    }
  }

  /** Mark channels as allowed — same membership projection as listAutoSubscriptionChannels. */
  function warmWsAclCacheFromChannelList(userId: string, channels: string[]) {
    for (const channel of channels) {
      // Bootstrap warming is local-only to avoid high Redis write volume on reconnect bursts.
      setAclDecision(userId, channel, true, { writeShared: false });
    }
  }

  function invalidateWsAclCache(userId: string, channel: string) {
    const key = aclCacheKey(userId, channel);
    aclCache.delete(key);
    aclCheckInFlight.delete(key);
    if (wsAclRedisTtlSecs <= 0) return;
    redis.del(aclRedisCacheKey(userId, channel)).catch(() => {});
  }

  // Evict expired entries periodically to prevent unbounded growth.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of aclCache) {
      if (v.expiresAt <= now) aclCache.delete(k);
    }
  }, 60_000).unref();

  return {
    aclCache,
    aclCheckInFlight,
    aclCacheKey,
    readAclSharedCacheEntry,
    setAclDecision,
    warmWsAclCacheFromChannelList,
    invalidateWsAclCache,
  };
}

module.exports = {
  createWsAclCacheStore,
};
