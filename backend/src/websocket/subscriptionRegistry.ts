function createRedisSubscriptionRegistry({
  redisSub,
  isRedisOperational,
}) {
  const { redisPubsubSubscribe, redisPubsubUnsubscribe } = require('../db/redis');
  const redisSubscribed = new Set();
  const redisSubscribeInFlight = new Map();

  async function ensureRedisChannelSubscribed(redisChannel) {
    if (redisSubscribed.has(redisChannel)) return;

    if (redisSubscribeInFlight.has(redisChannel)) {
      await redisSubscribeInFlight.get(redisChannel);
      return;
    }

    if (!isRedisOperational(redisSub)) {
      throw new Error("Redis subscriber is not available");
    }

    const op = Promise.resolve(redisPubsubSubscribe(redisChannel))
      .then(() => {
        redisSubscribed.add(redisChannel);
      })
      .finally(() => {
        redisSubscribeInFlight.delete(redisChannel);
      });

    redisSubscribeInFlight.set(redisChannel, op);
    await op;
  }

  function releaseRedisChannelSubscription(redisChannel) {
    if (redisSubscribed.has(redisChannel) && isRedisOperational(redisSub)) {
      redisSubscribed.delete(redisChannel);
      redisPubsubUnsubscribe(redisChannel);
    }
  }

  return {
    ensureRedisChannelSubscribed,
    releaseRedisChannelSubscription,
  };
}

module.exports = {
  createRedisSubscriptionRegistry,
};
