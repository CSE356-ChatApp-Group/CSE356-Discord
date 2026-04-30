function createStartupSubscriptionsLifecycle({
  ensureRedisChannelSubscribed,
  userFeedShardChannels,
  communityFeedShardChannels,
  logWsHotInfo,
}) {
  let wsStartupPromise = null;

  async function ensureShardSubscriptions() {
    await Promise.all([
      ...userFeedShardChannels.map((redisChannel) => ensureRedisChannelSubscribed(redisChannel)),
      ...communityFeedShardChannels.map((redisChannel) =>
        ensureRedisChannelSubscribed(redisChannel)),
    ]);
  }

  function ready() {
    if (!wsStartupPromise) {
      wsStartupPromise = ensureShardSubscriptions()
        .then(() => {
          logWsHotInfo(
            () => ({
              userfeedShards: userFeedShardChannels.length,
              communityfeedShards: communityFeedShardChannels.length,
            }),
            "WS userfeed + communityfeed shard subscriptions ready",
          );
        })
        .catch((err) => {
          wsStartupPromise = null;
          throw err;
        });
    }
    return wsStartupPromise;
  }

  return {
    ready,
  };
}

module.exports = {
  createStartupSubscriptionsLifecycle,
};
