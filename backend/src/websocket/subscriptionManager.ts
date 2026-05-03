function createSubscriptionManager({
  localUserClients,
  channelClients,
  communityClients,
  userIdFromTarget,
  ready,
  ensureRedisChannelSubscribed,
  releaseRedisChannelSubscription,
  markChannelRecentConnect,
  invalidateRecentConnectTargetsCache,
}) {
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
      releaseRedisChannelSubscription(redisChannel);
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
