function createBootstrapSubscriptionsHelpers({
  redis,
  isRedisOperational,
  query,
  logger,
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
  wsBootstrapIngressKey,
  readWsBootstrapIngressCacheBase,
  writeWsBootstrapIngressCacheBase,
  resolvedWsRuntimeConfig,
  warmWsAclCacheFromChannelList,
  subscribeClient,
  subscribeCommunityClient,
  parseChannelKey,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapWallDurationMs,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_BATCH_SIZE,
}) {
  const wsBootstrapListInFlight = new Map();
  const wsBootstrapIngressInFlight = new Map();
  let wsBootstrapDbInFlight = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function readWsBootstrapIngressCache(userId, scope = "default") {
    return readWsBootstrapIngressCacheBase(redis, isRedisOperational, userId, scope);
  }

  async function writeWsBootstrapIngressCache(userId, channels, scope = "default") {
    return writeWsBootstrapIngressCacheBase(
      redis,
      isRedisOperational,
      userId,
      channels,
      WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
      scope,
    );
  }

  async function tryAcquireBootstrapDbSlot() {
    let waited = 0;
    while (wsBootstrapDbInFlight >= WS_BOOTSTRAP_DB_MAX_IN_FLIGHT) {
      if (waited === 0) {
        wsBootstrapBlockedTotal.inc({ reason: "concurrency_cap" });
      }
      const step = Math.min(50, Math.max(10, WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS || 20));
      waited += step;
      await sleep(step + Math.floor(Math.random() * 15));
    }
    wsBootstrapDbInFlight += 1;
  }

  function releaseBootstrapDbSlot() {
    wsBootstrapDbInFlight = Math.max(0, wsBootstrapDbInFlight - 1);
  }

  function wsBootstrapCacheKey(userId, scope = "full") {
    return `ws:bootstrap:${userId}:${scope}`;
  }

  async function invalidateWsBootstrapCache(userId) {
    await invalidateWsBootstrapCaches([userId]);
  }

  async function invalidateWsBootstrapCaches(userIds) {
    const keys = [];
    const seen = new Set();
    for (const userId of Array.isArray(userIds) ? userIds : []) {
      if (typeof userId !== "string" || !userId || seen.has(userId)) continue;
      seen.add(userId);
      const messagesKey = wsBootstrapCacheKey(userId, "messages");
      const fullKey = wsBootstrapCacheKey(userId, "full");
      const userOnlyKey = wsBootstrapCacheKey(userId, "user_only");
      keys.push(
        `ws:bootstrap:${userId}`,
        wsBootstrapIngressKey(userId, "messages"),
        wsBootstrapIngressKey(userId, "full"),
        wsBootstrapIngressKey(userId, "user_only"),
        messagesKey,
        staleCacheKey(messagesKey),
        fullKey,
        staleCacheKey(fullKey),
        userOnlyKey,
        staleCacheKey(userOnlyKey),
      );
    }
    if (!keys.length) return;
    const UNLINK_BATCH = 500;
    if (keys.length <= UNLINK_BATCH) {
      await redis.unlink(...keys);
      return;
    }
    const pipeline = redis.pipeline();
    for (let i = 0; i < keys.length; i += UNLINK_BATCH) {
      pipeline.unlink(...keys.slice(i, i + UNLINK_BATCH));
    }
    await pipeline.exec();
  }

  function wsAutoSubscribeMode() {
    return resolvedWsRuntimeConfig().autoSubscribeMode;
  }

  async function listAutoSubscriptionChannels(userId, mode = "full") {
    const scope = mode === "full" ? "full" : (mode === "user_only" ? "user_only" : "messages");
    const cacheKey = wsBootstrapCacheKey(userId, scope);
    const cached = await getJsonCache(redis, cacheKey);
    if (Array.isArray(cached)) {
      wsBootstrapListCacheTotal.inc({ result: "hit" });
      wsBootstrapChannelsHistogram.observe(cached.length);
      return cached.filter((value) => typeof value === "string");
    }

    if (wsBootstrapListInFlight.has(cacheKey)) {
      wsBootstrapListCacheTotal.inc({ result: "coalesced" });
      const channels = await wsBootstrapListInFlight.get(cacheKey);
      wsBootstrapChannelsHistogram.observe(channels.length);
      return channels;
    }

    wsBootstrapListCacheTotal.inc({ result: "miss" });
    return withDistributedSingleflight({
      redis,
      cacheKey,
      inflight: wsBootstrapListInFlight,
      readFresh: async () => {
        const parsed = await getJsonCache(redis, cacheKey);
        return Array.isArray(parsed) ? parsed : null;
      },
      readStale: async () => {
        const parsed = await getJsonCache(redis, staleCacheKey(cacheKey));
        return Array.isArray(parsed) ? parsed : null;
      },
      load: async () => {
        wsBootstrapDbTotal.inc();
        const [conversationRes, communityRes, channelRes] = await Promise.all([
          scope === "user_only"
            ? Promise.resolve({ rows: [] })
            : query(
              `SELECT conversation_id::text AS id
               FROM conversation_participants
               WHERE user_id = $1 AND left_at IS NULL`,
              [userId],
            ),
          query(
            `SELECT community_id::text AS id
             FROM community_members
             WHERE user_id = $1`,
            [userId],
          ),
          scope === "user_only"
            ? Promise.resolve({ rows: [] })
            : query(
              `SELECT c.id::text AS id
               FROM channels c
               JOIN community_members cm
                 ON cm.community_id = c.community_id
                AND cm.user_id = $1
               LEFT JOIN channel_members chm
                 ON chm.channel_id = c.id
                AND chm.user_id = $1
               WHERE c.is_private = FALSE OR chm.user_id IS NOT NULL`,
              [userId],
            ),
        ]);

        const channels = [
          ...channelRes.rows.map((row) => `channel:${row.id}`),
          ...conversationRes.rows.map((row) => `conversation:${row.id}`),
          ...communityRes.rows.map((row) => `community:${row.id}`),
        ];
        wsBootstrapChannelsHistogram.observe(channels.length);
        await setJsonCacheWithStale(redis, cacheKey, channels, WS_BOOTSTRAP_CACHE_TTL_SECONDS, {
          staleMultiplier: 1.5,
          maxStaleTtlSeconds: 600,
        });
        return channels;
      },
    });
  }

  async function subscribeBootstrapChannel(ws, channel) {
    if (typeof channel === "string" && channel.startsWith("community:")) {
      const parsed = parseChannelKey(channel);
      if (parsed?.type === "community") subscribeCommunityClient(ws, parsed.id);
      return;
    }
    await subscribeClient(ws, channel);
  }

  async function bootstrapUserSubscriptions(ws, userId) {
    const mode = wsAutoSubscribeMode();
    const ingressScope = mode === "full" ? "full" : (mode === "user_only" ? "user_only" : "messages");
    const ingressCached = await readWsBootstrapIngressCache(userId, ingressScope);
    if (Array.isArray(ingressCached)) {
      wsBootstrapCachedTotal.inc({ source: "ttl" });
      warmWsAclCacheFromChannelList(userId, ingressCached);
      for (let i = 0; i < ingressCached.length; i += WS_BOOTSTRAP_BATCH_SIZE) {
        const batch = ingressCached.slice(i, i + WS_BOOTSTRAP_BATCH_SIZE);
        await Promise.allSettled(batch.map((channel) => subscribeBootstrapChannel(ws, channel)));
        if (ws.readyState !== 1) return;
      }
      return;
    }

    if (wsBootstrapIngressInFlight.has(userId)) {
      wsBootstrapCachedTotal.inc({ source: "inflight" });
      const channels = await wsBootstrapIngressInFlight.get(userId);
      warmWsAclCacheFromChannelList(userId, channels);
      for (let i = 0; i < channels.length; i += WS_BOOTSTRAP_BATCH_SIZE) {
        const batch = channels.slice(i, i + WS_BOOTSTRAP_BATCH_SIZE);
        await Promise.allSettled(batch.map((channel) => subscribeBootstrapChannel(ws, channel)));
        if (ws.readyState !== 1) return;
      }
      return;
    }

    await tryAcquireBootstrapDbSlot();
    const loadPromise = listAutoSubscriptionChannels(userId, mode)
      .finally(() => {
        wsBootstrapIngressInFlight.delete(userId);
        releaseBootstrapDbSlot();
      });
    wsBootstrapIngressInFlight.set(userId, loadPromise);

    const channels = await loadPromise;
    await writeWsBootstrapIngressCache(userId, channels, ingressScope);
    warmWsAclCacheFromChannelList(userId, channels);

    // Recent-connect ZADD + target-cache invalidation for `channel:*` topics run inside
    // subscribeClient (subscriptionManager) after a successful local subscribe — not here —
    // to avoid duplicating O(channels) Redis work before the same batched subscribeClient calls.

    for (let i = 0; i < channels.length; i += WS_BOOTSTRAP_BATCH_SIZE) {
      const batch = channels.slice(i, i + WS_BOOTSTRAP_BATCH_SIZE);
      await Promise.allSettled(batch.map((channel) => subscribeBootstrapChannel(ws, channel)));
      if (ws.readyState !== 1) return;
    }
  }

  async function bootstrapWithRetry(ws, userId, attempt = 0) {
    if (ws.readyState !== 1) return;
    if (attempt === 0) {
      ws._bootstrapWallStart = Date.now();
    }
    try {
      await bootstrapUserSubscriptions(ws, userId);
      const wallStart = ws._bootstrapWallStart || Date.now();
      const bootstrapWallMs = Date.now() - wallStart;
      wsBootstrapWallDurationMs.observe(bootstrapWallMs);
      if (bootstrapWallMs > 5000) {
        logger.warn({ userId, bootstrapWallMs }, "WS auto-subscribe bootstrap slow");
      }
    } catch (err) {
      const isCircuitOpen = err && err.code === "POOL_CIRCUIT_OPEN";
      if (isCircuitOpen && attempt < 3) {
        const delayMs = (attempt + 1) * 600;
        await new Promise((r) => setTimeout(r, delayMs));
        return bootstrapWithRetry(ws, userId, attempt + 1);
      }
      throw err;
    }
  }

  return {
    invalidateWsBootstrapCache,
    invalidateWsBootstrapCaches,
    subscribeBootstrapChannel,
    bootstrapWithRetry,
  };
}

module.exports = {
  createBootstrapSubscriptionsHelpers,
};
