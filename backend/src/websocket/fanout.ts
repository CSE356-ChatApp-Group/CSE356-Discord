/**
 * fanout.publish – publishes an event to a Redis Pub/Sub channel.
 * All API nodes subscribed to that channel will deliver it to their
 * locally-connected WebSocket clients.
 */

'use strict';

const redis = require('../db/redis');

async function publish(channel, payload) {
  await redis.publish(channel, JSON.stringify(payload));
}

module.exports = { publish };
