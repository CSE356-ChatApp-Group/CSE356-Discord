function bindRedisSubscriber({
  redisSub,
  deliverPubsubMessage,
  logger,
}) {
  redisSub.on("message", (channel, message) => {
    void deliverPubsubMessage(channel, message).catch((err) => {
      logger.error({ err, channel }, "deliverPubsubMessage failed");
    });
  });
}

module.exports = {
  bindRedisSubscriber,
};
