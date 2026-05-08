function createRedisSubscriptionRegistry({
  redisSub,
  isRedisOperational,
}) {
  const {
    redisPubsubSubscribe,
    redisPubsubSubscribeMany,
    redisPubsubUnsubscribe,
  } = require('../db/redis');
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

  async function ensureRedisChannelsSubscribed(redisChannels) {
    const uniqueChannels = Array.from(
      new Set(
        (Array.isArray(redisChannels) ? redisChannels : [])
          .filter((channel) => typeof channel === "string" && channel),
      ),
    );
    if (!uniqueChannels.length) return;

    const waitForExisting = [];
    const toSubscribe = [];
    for (const redisChannel of uniqueChannels) {
      if (redisSubscribed.has(redisChannel)) continue;
      const inFlight = redisSubscribeInFlight.get(redisChannel);
      if (inFlight) {
        waitForExisting.push(inFlight);
      } else {
        toSubscribe.push(redisChannel);
      }
    }

    if (!toSubscribe.length) {
      if (waitForExisting.length) {
        await Promise.all(waitForExisting);
      }
      return;
    }

    if (!isRedisOperational(redisSub)) {
      throw new Error("Redis subscriber is not available");
    }

    const start = Date.now();
    const op = Promise.resolve(redisPubsubSubscribeMany(toSubscribe))
      .then(() => {
        for (const redisChannel of toSubscribe) {
          redisSubscribed.add(redisChannel);
        }
        const elapsed = Date.now() - start;
        if (elapsed > 1000) {
          logger.warn(
            { redisChannelCount: toSubscribe.length, elapsedMs: elapsed },
            "Slow batched Redis subscription",
          );
        }
      })
      .catch((err) => {
        logger.error(
          { err, redisChannelCount: toSubscribe.length },
          "Batched Redis subscription failed",
        );
        throw err;
      })
      .finally(() => {
        for (const redisChannel of toSubscribe) {
          redisSubscribeInFlight.delete(redisChannel);
        }
      });

    for (const redisChannel of toSubscribe) {
      redisSubscribeInFlight.set(redisChannel, op);
    }
    if (waitForExisting.length) {
      await Promise.all([...waitForExisting, op]);
    } else {
      await op;
    }
  }

  function releaseRedisChannelSubscription(redisChannel) {
    if (redisSubscribed.has(redisChannel) && isRedisOperational(redisSub)) {
      redisSubscribed.delete(redisChannel);
      redisPubsubUnsubscribe(redisChannel);
    }
  }

  return {
    ensureRedisChannelSubscribed,
    ensureRedisChannelsSubscribed,
    releaseRedisChannelSubscription,
  };
}

module.exports = {
  createRedisSubscriptionRegistry,
};
