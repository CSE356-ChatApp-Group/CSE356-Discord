function createSubscriptionManager({
  localUserClients,
  channelClients,
  communityClients,
  userIdFromTarget,
  userFeedRedisChannelForUserId,
  ready,
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
  redisSubscriptionReleaseGraceMs = 0,
  markChannelRecentConnect,
  clearChannelBootstrapPending = null,
  invalidateRecentConnectTargetsCache,
  wsUserfeedOwnedShardsGauge = null,
  wsUserfeedShardSubscriptionTotal = null,
  getWorkerLabels = null,
}) {
  const pendingRedisReleaseTimers = new Map();
  const localUserFeedShardRefCounts = new Map();

  function isGraceEligibleRedisTopic(redisChannel) {
    return redisChannel.startsWith("channel:") || redisChannel.startsWith("conversation:");
  }

  function workerLabels() {
    if (typeof getWorkerLabels === "function") {
      return getWorkerLabels();
    }
    return { vm: "unknown", worker: "unknown" };
  }

  function updateOwnedShardGauge() {
    const wl = workerLabels();
    wsUserfeedOwnedShardsGauge?.set?.(
      { vm: wl.vm, worker: wl.worker },
      localUserFeedShardRefCounts.size,
    );
  }

  function incrementOwnedUserfeedShard(redisChannel) {
    const nextCount = (localUserFeedShardRefCounts.get(redisChannel) || 0) + 1;
    const firstOwner = nextCount === 1;
    localUserFeedShardRefCounts.set(redisChannel, nextCount);
    if (firstOwner) {
      const wl = workerLabels();
      const shard = redisChannel.startsWith("userfeed:") ? redisChannel.slice("userfeed:".length) : "unknown";
      wsUserfeedShardSubscriptionTotal?.inc?.(
        { action: "acquired", shard, vm: wl.vm, worker: wl.worker },
        1,
      );
    }
    updateOwnedShardGauge();
  }

  function decrementOwnedUserfeedShard(redisChannel) {
    const current = localUserFeedShardRefCounts.get(redisChannel) || 0;
    if (current <= 1) {
      localUserFeedShardRefCounts.delete(redisChannel);
      const wl = workerLabels();
      const shard = redisChannel.startsWith("userfeed:") ? redisChannel.slice("userfeed:".length) : "unknown";
      wsUserfeedShardSubscriptionTotal?.inc?.(
        { action: "released", shard, vm: wl.vm, worker: wl.worker },
        1,
      );
      updateOwnedShardGauge();
      return true;
    }
    localUserFeedShardRefCounts.set(redisChannel, current - 1);
    updateOwnedShardGauge();
    return false;
  }

  function clearPendingRedisRelease(redisChannel) {
    const timer = pendingRedisReleaseTimers.get(redisChannel);
    if (!timer) return;
    clearTimeout(timer);
    pendingRedisReleaseTimers.delete(redisChannel);
  }

  function releaseRedisTopicMaybeWithGrace(redisChannel) {
    if (!isGraceEligibleRedisTopic(redisChannel) || redisSubscriptionReleaseGraceMs <= 0) {
      releaseRedisChannelSubscription(redisChannel);
      return;
    }
    if (pendingRedisReleaseTimers.has(redisChannel)) return;

    const timer = setTimeout(() => {
      pendingRedisReleaseTimers.delete(redisChannel);
      if ((channelClients.get(redisChannel)?.size || 0) > 0) return;
      releaseRedisChannelSubscription(redisChannel);
    }, redisSubscriptionReleaseGraceMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingRedisReleaseTimers.set(redisChannel, timer);
  }

  function subscribeCommunityClient(ws, communityId) {
    if (typeof communityId !== "string" || !communityId) return;
    if (!ws._communityIds) ws._communityIds = new Set();
    if (ws._communityIds.has(communityId)) return;
    ws._communityIds.add(communityId);
    if (!communityClients.has(communityId)) {
      communityClients.set(communityId, new Set());
    }
    communityClients.get(communityId).add(ws);
  }

  function unsubscribeCommunityClient(ws, communityId) {
    if (typeof communityId !== "string" || !communityId) return;
    ws._communityIds?.delete(communityId);
    const clients = communityClients.get(communityId);
    clients?.delete(ws);
    if ((clients?.size || 0) === 0) {
      communityClients.delete(communityId);
    }
  }

  async function subscribeClient(ws, redisChannel) {
    if (ws._subscriptions.has(redisChannel)) return;

    const userId = userIdFromTarget(redisChannel);
    if (redisChannel.startsWith("user:") && userId) {
      await ready();
      const userFeedShardChannel = userFeedRedisChannelForUserId(userId);
      clearPendingRedisRelease(userFeedShardChannel);
      await ensureRedisChannelSubscribed(userFeedShardChannel);
      if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
      if (!localUserClients.has(userId)) {
        localUserClients.set(userId, new Set());
      }
      localUserClients.get(userId).add(ws);
      ws._subscriptions.add(redisChannel);
      incrementOwnedUserfeedShard(userFeedShardChannel);
      return;
    }

    clearPendingRedisRelease(redisChannel);
    await ensureRedisChannelSubscribed(redisChannel);

    // Guard: socket may have closed during the Redis await above.
    // cleanup() already ran; adding a CLOSED socket to channelClients would
    // leave a stale entry until the next message on this channel prunes it.
    if (ws.readyState !== 1 /* WebSocket.OPEN */) return;

    if (!channelClients.has(redisChannel)) {
      channelClients.set(redisChannel, new Set());
    }
    channelClients.get(redisChannel).add(ws);
    ws._subscriptions.add(redisChannel);
    if (redisChannel.startsWith("channel:")) {
      ws._explicitChannelUnsub?.delete(redisChannel);
      const uid = ws._userId;
      if (uid) {
        const channelId = redisChannel.slice("channel:".length);
        clearChannelBootstrapPending?.(uid, channelId).catch(() => {});
        const skipRecentConnectSideEffects = ws._bootstrapRecentConnectChannelIds?.has(channelId);
        if (!skipRecentConnectSideEffects) {
          markChannelRecentConnect(uid, channelId)
            .then(() => invalidateRecentConnectTargetsCache?.(channelId))
            .catch(() => {});
        }
      }
    }
  }

  async function unsubscribeClient(ws, redisChannel) {
    if (!ws._subscriptions.has(redisChannel)) return;
    const userId = userIdFromTarget(redisChannel);
    if (redisChannel.startsWith("user:") && userId) {
      const clients = localUserClients.get(userId);
      clients?.delete(ws);
      if ((clients?.size || 0) === 0) {
        localUserClients.delete(userId);
      }
      ws._subscriptions.delete(redisChannel);
      const userFeedShardChannel = userFeedRedisChannelForUserId(userId);
      const shouldRelease = decrementOwnedUserfeedShard(userFeedShardChannel);
      if (shouldRelease) {
        releaseRedisChannelSubscription(userFeedShardChannel);
      }
      return;
    }

    channelClients.get(redisChannel)?.delete(ws);
    ws._subscriptions.delete(redisChannel);
    if (redisChannel.startsWith("channel:")) {
      ws._explicitChannelUnsub?.add(redisChannel);
    }

    if ((channelClients.get(redisChannel)?.size || 0) === 0) {
      channelClients.delete(redisChannel);
      // No local subscribers remain — release the Redis subscription so the
      // subscriber connection doesn't accumulate channels indefinitely.
      releaseRedisTopicMaybeWithGrace(redisChannel);
    }
  }

  return {
    subscribeCommunityClient,
    unsubscribeCommunityClient,
    subscribeClient,
    unsubscribeClient,
  };
}

module.exports = {
  createSubscriptionManager,
};
