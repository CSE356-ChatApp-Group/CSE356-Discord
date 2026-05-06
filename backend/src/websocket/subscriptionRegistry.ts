function createRedisSubscriptionRegistry({
  redisSub,
  isRedisOperational,
}) {
  const { redisPubsubSubscribe, redisPubsubUnsubscribe } = require('../db/redis');
  const logger = require('../utils/logger');
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

    const start = Date.now();
    const op = Promise.resolve(redisPubsubSubscribe(redisChannel))
      .then(() => {
        redisSubscribed.add(redisChannel);
        const elapsed = Date.now() - start;
        if (elapsed > 1000) {
          logger.warn({ redisChannel, elapsedMs: elapsed }, "Slow Redis subscription");
        }
      })
      .catch((err) => {
        logger.error({ err, redisChannel }, "Redis subscription failed");
        throw err;
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
