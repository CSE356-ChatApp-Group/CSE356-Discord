function bindRedisSubscriber({
  redisSub,
  deliverPubsubMessage,
  logger,
}) {
  const { REDIS_PUBSUB_EVENT } = require('../db/redis');

  // Cluster mode: "smessage" (sharded pub/sub). Standalone: "message".
  redisSub.on(REDIS_PUBSUB_EVENT, (channel, message) => {
    void deliverPubsubMessage(channel, message).catch((err) => {
      logger.error({ err, channel }, "deliverPubsubMessage failed");
    });
  });
}

module.exports = {
  bindRedisSubscriber,
};
