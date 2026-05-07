function createBootstrapSubscriptionsHelpers({
  redis,
  isRedisOperational,
  query,
  queryRead,
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
  markChannelRecentConnect,
  markChannelBootstrapPending = null,
  invalidateRecentConnectTargetsCache,
  subscribeClient,
  subscribeCommunityClient,
  parseChannelKey,
  wsBootstrapListCacheTotal,
  wsBootstrapChannelsHistogram,
  wsBootstrapBlockedTotal,
  wsBootstrapCachedTotal,
  wsBootstrapDbTotal,
  wsBootstrapWallDurationMs,
  wsBootstrapDbQueryDurationMs = null,
  wsBootstrapHydrationStepDurationMs = null,
  bootstrapHydrationScheduler = null,
  wsBootstrapReplicaReadTotal = null,
  wsBootstrapReplicaFallbackTotal = null,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_BATCH_SIZE,
}) {
  const {
    recordWsBootstrapWallMs,
  } = require("./wsDeliveryPressure");
  const { redisBatchUnlink } = require("../db/redisBatch");

  const {
    channelRecentConnectKey,
    channelRecentZsetEnabled,
    WS_RECENT_CONNECT_TTL_SECONDS: RECENT_CONNECT_TTL_SEC,
  } = require("./recentConnect");

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

  function sanitizeBootstrapChannels(value) {
    return Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string")
      : null;
  }

  function observeBootstrapListCache(result, channels) {
    wsBootstrapListCacheTotal.inc({ result });
    wsBootstrapChannelsHistogram.observe(channels.length);
  }

  function shouldFallbackBootstrapReadToPrimary(err) {
    const code = String(err?.code || "");
    const msg = String(err?.message || "").toLowerCase();
    return (
      code === "READ_REPLICA_DISABLED"
      || code === "READ_REPLICA_UNHEALTHY"
      || code === "READ_REPLICA_ERROR"
      || msg.includes("read replica")
      || msg.includes("econnrefused")
      || msg.includes("timeout")
      || msg.includes("terminated")
      || msg.includes("connection")
    );
  }

  async function bootstrapListQuery(phase, text, values) {
    if (typeof queryRead !== "function") {
      return query(text, values);
    }
    try {
      const result = await queryRead({ text, values });
      if (wsBootstrapReplicaReadTotal) wsBootstrapReplicaReadTotal.inc({ phase });
      return result;
    } catch (err) {
      if (!shouldFallbackBootstrapReadToPrimary(err)) {
        throw err;
      }
      if (wsBootstrapReplicaFallbackTotal) wsBootstrapReplicaFallbackTotal.inc({ phase });
      logger.warn(
        { err, phase },
        "WS bootstrap list query falling back to primary after replica read error",
      );
      return query(text, values);
    }
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
    await redisBatchUnlink(redis, keys, 500);
  }

  function wsAutoSubscribeMode() {
    return resolvedWsRuntimeConfig().autoSubscribeMode;
  }

  async function loadBootstrapChannelsFromDb(userId, scope, cacheKey) {
    await tryAcquireBootstrapDbSlot();
    try {
      wsBootstrapDbTotal.inc();

      function timedQuery(phase, fn) {
        if (!wsBootstrapDbQueryDurationMs) return fn();
        const start = Date.now();
        return Promise.resolve(fn()).then((result) => {
          wsBootstrapDbQueryDurationMs.observe({ phase }, Date.now() - start);
          return result;
        });
      }

      const [conversationRes, communityRes, channelRes] = await Promise.all([
        scope === "user_only"
          ? Promise.resolve({ rows: [] })
          : timedQuery("conversations", () => bootstrapListQuery(
            "conversations",
            `SELECT conversation_id::text AS id
               FROM conversation_participants
               WHERE user_id = $1 AND left_at IS NULL`,
            [userId],
          )),
        // Skip community query in messages scope: community:* topics are not needed
        // for message:created delivery — subscribeClient covers channel/conversation fanout.
        scope === "user_only" || scope === "messages"
          ? Promise.resolve({ rows: [] })
          : timedQuery("communities", () => bootstrapListQuery(
            "communities",
            `SELECT community_id::text AS id
               FROM community_members
               WHERE user_id = $1`,
            [userId],
          )),
        scope === "user_only"
          ? Promise.resolve({ rows: [] })
          : timedQuery("channels", () => bootstrapListQuery(
            "channels",
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
          )),
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
    } finally {
      releaseBootstrapDbSlot();
    }
  }

  function refreshBootstrapChannelsInBackground(userId, scope, cacheKey) {
    if (wsBootstrapListInFlight.has(cacheKey)) return;
    const refresh = withDistributedSingleflight({
      redis,
      cacheKey,
      inflight: wsBootstrapListInFlight,
      readFresh: async () => {
        const parsed = await getJsonCache(redis, cacheKey);
        return sanitizeBootstrapChannels(parsed);
      },
      readStale: async () => null,
      load: () => loadBootstrapChannelsFromDb(userId, scope, cacheKey),
    });
    refresh.catch((err) => {
      logger.warn(
        { err, userId, scope },
        "WS bootstrap stale cache background refresh failed",
      );
    });
  }

  async function listAutoSubscriptionChannels(userId, mode = "full") {
    const scope = mode === "full" ? "full" : (mode === "user_only" ? "user_only" : "messages");
    const cacheKey = wsBootstrapCacheKey(userId, scope);
    const cached = sanitizeBootstrapChannels(await getJsonCache(redis, cacheKey));
    if (cached) {
      observeBootstrapListCache("hit", cached);
      return cached;
    }

    const stale = sanitizeBootstrapChannels(await getJsonCache(redis, staleCacheKey(cacheKey)));
    if (stale) {
      observeBootstrapListCache("stale", stale);
      refreshBootstrapChannelsInBackground(userId, scope, cacheKey);
      return stale;
    }

    if (wsBootstrapListInFlight.has(cacheKey)) {
      wsBootstrapListCacheTotal.inc({ result: "coalesced" });
      const channels = await wsBootstrapListInFlight.get(cacheKey);
      const sanitized = sanitizeBootstrapChannels(channels) || [];
      wsBootstrapChannelsHistogram.observe(sanitized.length);
      return sanitized;
    }

    wsBootstrapListCacheTotal.inc({ result: "miss" });
    return withDistributedSingleflight({
      redis,
      cacheKey,
      inflight: wsBootstrapListInFlight,
      readFresh: async () => {
        const parsed = await getJsonCache(redis, cacheKey);
        return sanitizeBootstrapChannels(parsed);
      },
      readStale: async () => {
        const parsed = await getJsonCache(redis, staleCacheKey(cacheKey));
        return sanitizeBootstrapChannels(parsed);
      },
      load: () => loadBootstrapChannelsFromDb(userId, scope, cacheKey),
    });
  }

  function clearBootstrapRecentConnectPrimed(ws) {
    if (ws && ws._bootstrapRecentConnectChannelIds) {
      delete ws._bootstrapRecentConnectChannelIds;
    }
  }

  /**
   * Early ZADD into channel:recent_connect:* so recent_connect fanout sees the user before
   * batched subscribeClient completes. Records primed channel IDs so subscribeClient can
   * skip duplicate mark + target-cache invalidation for those channels.
   */
  async function primeBootstrapChannelRecentConnect(ws, userId, channels) {
    const channelTopics = (channels || []).filter(
      (ch) => typeof ch === "string" && ch.startsWith("channel:"),
    );
    if (!channelTopics.length) return;
    ws._bootstrapRecentConnectChannelIds = new Set();

    const channelIds = channelTopics.map((ch) => ch.slice("channel:".length));
    await markChannelBootstrapPending?.(userId, channelIds).catch((err) => {
      logger.warn(
        { err, userId, channelCount: channelIds.length },
        "WS bootstrap pending-channel marker failed",
      );
    });

    // Per-channel precheck: pipeline ZSCORE for each channel to find which ones
    // already have a recent-enough score for this user. Channels where the score
    // is present and within the TTL window skip the ZADD and cache invalidation,
    // keeping the fanout target cache warm. Channels that are new, stale, or
    // whose lookup errored are still fully marked. Falls back to full mark on any
    // pipeline-level failure.
    let needsMark = channelIds.map(() => true);
    if (channelRecentZsetEnabled()) {
      try {
        const cutoff = Date.now() - RECENT_CONNECT_TTL_SEC * 1000;
        const pipeline = redis.pipeline();
        for (const channelId of channelIds) {
          pipeline.zscore(channelRecentConnectKey(channelId), userId);
        }
        const results = await pipeline.exec();
        needsMark = channelIds.map((_channelId, idx) => {
          const [err, score] = results[idx] ?? [null, null];
          if (err) return true;
          const n = score != null ? Number(score) : NaN;
          return !Number.isFinite(n) || n < cutoff;
        });
      } catch (_err) {
        // Pipeline failed entirely — fall back to marking all channels.
      }
    }

    const settled = await Promise.allSettled(
      channelIds.map(async (channelId, idx) => {
        if (needsMark[idx]) {
          await markChannelRecentConnect(userId, channelId);
          await invalidateRecentConnectTargetsCache?.(channelId);
        }
        return channelId;
      }),
    );
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      if (r.status === "fulfilled" && ws._bootstrapRecentConnectChannelIds) {
        ws._bootstrapRecentConnectChannelIds.add(r.value);
      }
    }
  }

  async function subscribeBootstrapChannel(ws, channel) {
    if (typeof channel === "string" && channel.startsWith("community:")) {
      const parsed = parseChannelKey(channel);
      if (parsed?.type === "community") subscribeCommunityClient(ws, parsed.id);
      return;
    }
    await subscribeClient(ws, channel);
  }

  async function prepareBootstrapSubscriptions(ws, userId) {
    const mode = wsAutoSubscribeMode();
    const ingressScope = mode === "full" ? "full" : (mode === "user_only" ? "user_only" : "messages");
    const ingressCached = await readWsBootstrapIngressCache(userId, ingressScope);
    if (Array.isArray(ingressCached)) {
      wsBootstrapCachedTotal.inc({ source: "ttl" });
      warmWsAclCacheFromChannelList(userId, ingressCached);
      await primeBootstrapChannelRecentConnect(ws, userId, ingressCached);
      return ingressCached;
    }

    if (wsBootstrapIngressInFlight.has(userId)) {
      wsBootstrapCachedTotal.inc({ source: "inflight" });
      const channels = await wsBootstrapIngressInFlight.get(userId);
      warmWsAclCacheFromChannelList(userId, channels);
      await primeBootstrapChannelRecentConnect(ws, userId, channels);
      return channels;
    }

    const loadPromise = listAutoSubscriptionChannels(userId, mode)
      .finally(() => {
        wsBootstrapIngressInFlight.delete(userId);
      });
    wsBootstrapIngressInFlight.set(userId, loadPromise);

    const channels = await loadPromise;
    await writeWsBootstrapIngressCache(userId, channels, ingressScope);
    warmWsAclCacheFromChannelList(userId, channels);
    await primeBootstrapChannelRecentConnect(ws, userId, channels);
    return channels;
  }

  async function hydrateBootstrapSubscriptions(ws, channels) {
    if (!Array.isArray(channels)) return;

    // Partition: delivery channels (channel:*, conversation:*) must be set up before
    // community channels, which are non-critical for message:created delivery and synchronous.
    const deliveryChannels = [];
    const communityChannels = [];
    for (const ch of channels) {
      if (typeof ch !== "string") continue;
      if (ch.startsWith("community:")) {
        communityChannels.push(ch);
      } else {
        deliveryChannels.push(ch);
      }
    }

    // Step 1: Delivery channels — batched async, yields to live fanout between batches
    if (deliveryChannels.length > 0) {
      const stepStart = Date.now();
      for (let i = 0; i < deliveryChannels.length; i += WS_BOOTSTRAP_BATCH_SIZE) {
        await bootstrapHydrationScheduler?.waitForLiveFanoutQuiet?.();
        const batch = deliveryChannels.slice(i, i + WS_BOOTSTRAP_BATCH_SIZE);
        await Promise.allSettled(batch.map((channel) => subscribeBootstrapChannel(ws, channel)));
        if (ws.readyState !== 1) return;
      }
      wsBootstrapHydrationStepDurationMs?.observe?.({ step: "delivery" }, Date.now() - stepStart);
    }

    // Step 2: Community channels — subscribeCommunityClient is synchronous in-memory;
    // no fanout yield or async batching needed.
    if (communityChannels.length > 0 && ws.readyState === 1) {
      const stepStart = Date.now();
      for (const channel of communityChannels) {
        const parsed = parseChannelKey(channel);
        if (parsed?.type === "community") subscribeCommunityClient(ws, parsed.id);
      }
      wsBootstrapHydrationStepDurationMs?.observe?.({ step: "community" }, Date.now() - stepStart);
    }
  }

  async function bootstrapUserSubscriptions(ws, userId) {
    const channels = await prepareBootstrapSubscriptions(ws, userId);
    await hydrateBootstrapSubscriptions(ws, channels);
    return channels;
  }

  function observeBootstrapWall(ws, userId) {
    const wallStart = ws._bootstrapWallStart || Date.now();
    const bootstrapWallMs = Date.now() - wallStart;
    wsBootstrapWallDurationMs.observe(bootstrapWallMs);
    recordWsBootstrapWallMs(bootstrapWallMs);
    if (bootstrapWallMs > 5000) {
      logger.warn({ userId, bootstrapWallMs }, "WS auto-subscribe bootstrap slow");
    }
  }

  async function bootstrapWithRetry(ws, userId, attempt = 0) {
    if (ws.readyState !== 1) return;
    if (attempt === 0) {
      ws._bootstrapWallStart = Date.now();
    }
    try {
      await bootstrapUserSubscriptions(ws, userId);
      observeBootstrapWall(ws, userId);
    } catch (err) {
      const isCircuitOpen = err && err.code === "POOL_CIRCUIT_OPEN";
      if (isCircuitOpen && attempt < 3) {
        const delayMs = (attempt + 1) * 600;
        await new Promise((r) => setTimeout(r, delayMs));
        return bootstrapWithRetry(ws, userId, attempt + 1);
      }
      throw err;
    } finally {
      clearBootstrapRecentConnectPrimed(ws);
    }
  }

  async function prepareBootstrapWithRetry(ws, userId, attempt = 0) {
    if (ws.readyState !== 1) return [];
    if (attempt === 0) {
      ws._bootstrapWallStart = Date.now();
    }
    try {
      return await prepareBootstrapSubscriptions(ws, userId);
    } catch (err) {
      const isCircuitOpen = err && err.code === "POOL_CIRCUIT_OPEN";
      if (isCircuitOpen && attempt < 3) {
        const delayMs = (attempt + 1) * 600;
        await new Promise((r) => setTimeout(r, delayMs));
        return prepareBootstrapWithRetry(ws, userId, attempt + 1);
      }
      clearBootstrapRecentConnectPrimed(ws);
      throw err;
    }
  }

  async function hydrateBootstrapWithMetrics(ws, userId, channels) {
    const runHydration = async (targetWs, targetChannels) => {
      await hydrateBootstrapSubscriptions(targetWs, targetChannels);
      observeBootstrapWall(targetWs, userId);
      return { status: "hydrated" };
    };
    try {
      if (bootstrapHydrationScheduler?.enqueueHydration) {
        return await bootstrapHydrationScheduler.enqueueHydration(
          ws,
          userId,
          Array.isArray(channels) ? channels : [],
          runHydration,
        );
      }
      return await runHydration(ws, Array.isArray(channels) ? channels : []);
    } finally {
      clearBootstrapRecentConnectPrimed(ws);
    }
  }

  return {
    invalidateWsBootstrapCache,
    invalidateWsBootstrapCaches,
    subscribeBootstrapChannel,
    bootstrapWithRetry,
    prepareBootstrapWithRetry,
    hydrateBootstrapWithMetrics,
    clearBootstrapPriming: clearBootstrapRecentConnectPrimed,
  };
}

module.exports = {
  createBootstrapSubscriptionsHelpers,
};
