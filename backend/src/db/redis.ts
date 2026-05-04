/**
 * Redis clients (ioredis):
 *
 *   redis      – main client: fanout, presence, caches, rate limits
 *   redisAuth  – auth-only client: JWT deny-list, auth rate-limit counters
 *                Configured via REDIS_AUTH_URL (falls back to REDIS_URL).
 *                Isolated so messaging fanout traffic cannot starve auth checks.
 *   redisSub   – dedicated subscriber for pub/sub fanout; cannot issue normal
 *                commands once subscribed.
 */


const Redis  = require('ioredis');
const logger = require('../utils/logger');

function createClient(name, url) {
  const client = new Redis(url, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  client.on('connect',      () => logger.info({ client: name }, 'Redis connected'));
  client.on('reconnecting', () => logger.warn({ client: name }, 'Redis reconnecting'));
  client.on('error', (err) => logger.error({ err, client: name }, 'Redis error'));

  return client;
}

const REDIS_URL      = process.env.REDIS_URL      || 'redis://localhost:6379';
const REDIS_AUTH_URL = process.env.REDIS_AUTH_URL || REDIS_URL;

// General-purpose client: fanout, presence, caches
const redis = createClient('main', REDIS_URL);

// Auth-only client: JWT deny-list + auth rate-limit counters.
// Separate connection so heavy fanout/pub-sub traffic on REDIS_URL cannot
// cause the denylist EXISTS check to queue behind large pipeline flushes.
const redisAuth = createClient('auth', REDIS_AUTH_URL);

// Dedicated subscriber – used by ws/fanout; cannot issue normal commands.
// enableReadyCheck must be false: ioredis runs INFO as its ready-check, but
// INFO is not allowed on a connection that is (or has previously been) in
// subscriber mode, causing an immediate error that transitions the client to
// a broken state and prevents startup.
const redisSub = new Redis(REDIS_URL, {
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
    redisAuth.quit(),
    redisSub.quit(),
  ]);
}

module.exports = redis;
module.exports.redisAuth = redisAuth;
module.exports.redisSub = redisSub;
module.exports.closeRedisConnections = closeRedisConnections;
