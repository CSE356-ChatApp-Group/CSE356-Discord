function createSubscriptionManager({
  localUserClients,
  channelClients,
  communityClients,
  userIdFromTarget,
  communityFeedRedisChannelForCommunityId,
  ready,
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
  redisSubscriptionReleaseGraceMs = 0,
  markChannelRecentConnect,
  clearChannelBootstrapPending = null,
  invalidateRecentConnectTargetsCache,
}) {
  const pendingRedisReleaseTimers = new Map();
  const localCommunityFeedShardRefCounts = new Map();

  function isGraceEligibleRedisTopic(redisChannel) {
    return redisChannel.startsWith("channel:") || redisChannel.startsWith("conversation:");
  }

  function incrementOwnedCommunityfeedShard(redisChannel) {
    const nextCount = (localCommunityFeedShardRefCounts.get(redisChannel) || 0) + 1;
    localCommunityFeedShardRefCounts.set(redisChannel, nextCount);
  }

  function decrementOwnedCommunityfeedShard(redisChannel) {
    const current = localCommunityFeedShardRefCounts.get(redisChannel) || 0;
    if (current <= 1) {
      localCommunityFeedShardRefCounts.delete(redisChannel);
      return true;
    }
    localCommunityFeedShardRefCounts.set(redisChannel, current - 1);
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

  async function subscribeCommunityClient(ws, communityId) {
    if (typeof communityId !== "string" || !communityId) return;
    await ready();
    const communityFeedShardChannel = communityFeedRedisChannelForCommunityId(communityId);
    clearPendingRedisRelease(communityFeedShardChannel);
    await ensureRedisChannelSubscribed(communityFeedShardChannel);
    if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
    if (!ws._communityIds) ws._communityIds = new Set();
    if (ws._communityIds.has(communityId)) return;
    ws._communityIds.add(communityId);
    if (!communityClients.has(communityId)) {
      communityClients.set(communityId, new Set());
    }
    communityClients.get(communityId).add(ws);
    incrementOwnedCommunityfeedShard(communityFeedShardChannel);
  }

  function unsubscribeCommunityClient(ws, communityId) {
    if (typeof communityId !== "string" || !communityId) return;
    ws._communityIds?.delete(communityId);
    const clients = communityClients.get(communityId);
    clients?.delete(ws);
    if ((clients?.size || 0) === 0) {
      communityClients.delete(communityId);
    }
    const communityFeedShardChannel = communityFeedRedisChannelForCommunityId(communityId);
    const shouldRelease = decrementOwnedCommunityfeedShard(communityFeedShardChannel);
    if (shouldRelease) {
      releaseRedisChannelSubscription(communityFeedShardChannel);
    }
  }

  async function subscribeClient(ws, redisChannel) {
    if (ws._subscriptions.has(redisChannel)) return;

    const userId = userIdFromTarget(redisChannel);
    if (redisChannel.startsWith("user:") && userId) {
      if (!localUserClients.has(userId)) {
        localUserClients.set(userId, new Set());
      }
      localUserClients.get(userId).add(ws);
      ws._subscriptions.add(redisChannel);
      try {
        await ready();
      } catch (err) {
        const clients = localUserClients.get(userId);
        clients?.delete(ws);
        if ((clients?.size || 0) === 0) {
          localUserClients.delete(userId);
        }
        ws._subscriptions.delete(redisChannel);
        throw err;
      }
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
    const userId = userIdFromTarget(redisChannel);
    if (redisChannel.startsWith("user:") && userId) {
      const clients = localUserClients.get(userId);
      clients?.delete(ws);
      if ((clients?.size || 0) === 0) {
        localUserClients.delete(userId);
      }
      ws._subscriptions.delete(redisChannel);
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