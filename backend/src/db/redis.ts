/**
 * Redis client (ioredis) – singleton used for:
 *   • Pub/Sub fanout (separate subscriber client)
 *   • Presence TTL keys
 *   • Session / JWT deny-list
 *   • General caching
 *
 * Pub/Sub requires a dedicated connection because a subscribed client
 * cannot issue regular commands.
 */

'use strict';

const Redis  = require('ioredis');
const logger = require('../utils/logger');

function createClient(name) {
  const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  client.on('connect',      () => logger.info({ client: name }, 'Redis connected'));
  client.on('reconnecting', () => logger.warn({ client: name }, 'Redis reconnecting'));
  client.on('error', (err) => logger.error({ err, client: name }, 'Redis error'));

  return client;
}

// General-purpose client
const redis = createClient('main');

// Dedicated subscriber – used by ws/fanout; cannot issue normal commands.
// enableReadyCheck must be false: ioredis runs INFO as its ready-check, but
// INFO is not allowed on a connection that is (or has previously been) in
// subscriber mode, causing an immediate error that transitions the client to
// a broken state and prevents startup.
const redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});
redisSub.on('connect',      () => logger.info({ client: 'subscriber' }, 'Redis connected'));
redisSub.on('reconnecting', () => logger.warn({ client: 'subscriber' }, 'Redis reconnecting'));
redisSub.on('error', (err) => logger.error({ err, client: 'subscriber' }, 'Redis error'));

async function closeRedisConnections() {
  await Promise.allSettled([
    redis.quit(),
    redisSub.quit(),
  ]);
}

module.exports = redis;
module.exports.redisSub = redisSub;
module.exports.closeRedisConnections = closeRedisConnections;
