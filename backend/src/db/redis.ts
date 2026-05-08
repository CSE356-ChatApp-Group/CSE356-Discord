/**
 * Redis clients (ioredis):
 *
 *   redis      – main client: fanout, presence, caches, rate limits
 *   redisAuth  – auth-only client: JWT deny-list, auth rate-limit counters
 *                Always a standalone connection via REDIS_AUTH_URL (falls back
 *                to REDIS_URL). Kept standalone even in cluster mode so auth
 *                latency is never affected by cluster rebalancing, slot
 *                redirects, or fanout pipeline pressure.
 *   redisSub   – dedicated subscriber for pub/sub fanout; cannot issue normal
 *                commands once subscribed.
 *
 * Cluster mode:
 *   Set REDIS_CLUSTER_NODES to a comma-separated list of "host:port" pairs, e.g.
 *   "redis-0:7001,redis-1:7002,redis-2:7003". When set, `redis` and `redisSub`
 *   become Redis.Cluster instances and pub/sub switches to sharded pub/sub
 *   (SSUBSCRIBE / SPUBLISH) so hot channels are distributed across shards instead
 *   of broadcasting to every node. `redisAuth` is unaffected and always connects
 *   to the standalone instance at REDIS_AUTH_URL.
 */


const Redis  = require('ioredis');
const logger = require('../utils/logger');

const REDIS_URL       = process.env.REDIS_URL       || 'redis://localhost:6379';
const REDIS_AUTH_URL  = process.env.REDIS_AUTH_URL  || REDIS_URL;
const REDIS_SEARCH_URL = process.env.REDIS_SEARCH_URL || REDIS_URL;

// Comma-separated "host:port" list. When set, redis + redisSub run in cluster mode.
// redisAuth and redisSearch always use their respective URLs (standalone) regardless of this setting.
const REDIS_CLUSTER_NODES    = process.env.REDIS_CLUSTER_NODES    || '';
const REDIS_CLUSTER_PASSWORD = process.env.REDIS_CLUSTER_PASSWORD || '';

const REDIS_IS_CLUSTER = Boolean(REDIS_CLUSTER_NODES.trim());

function parseClusterNodes(nodesStr: string) {
  return nodesStr.split(',').map((s) => {
    const trimmed = s.trim();
    const colonIdx = trimmed.lastIndexOf(':');
    const host = colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
    const port  = colonIdx > 0 ? parseInt(trimmed.slice(colonIdx + 1), 10) : 7001;
    return { host, port };
  });
}

const CLUSTER_NODES = REDIS_IS_CLUSTER ? parseClusterNodes(REDIS_CLUSTER_NODES) : [];
const clusterAuth   = REDIS_CLUSTER_PASSWORD ? { password: REDIS_CLUSTER_PASSWORD } : {};

const STANDALONE_OPTIONS = {
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

const CLUSTER_OPTIONS = {
  redisOptions: { ...STANDALONE_OPTIONS, ...clusterAuth },
  clusterRetryStrategy: (times: number) => Math.min(times * 100, 3000),
};

function attachListeners(client: any, name: string) {
  client.on('connect',      () => logger.info({ client: name }, 'Redis connected'));
  client.on('ready',        () => logger.info({ client: name }, 'Redis ready'));
  client.on('reconnecting', () => logger.warn({ client: name }, 'Redis reconnecting'));
  client.on('error', (err: Error) => logger.error({ err, client: name }, 'Redis error'));
  client.on('end',          () => logger.info({ client: name }, 'Redis connection ended'));
}

function createStandaloneClient(name: string, url: string) {
  const client = new Redis(url, STANDALONE_OPTIONS);
  attachListeners(client, name);
  return client;
}

function createMainClient(name: string) {
  const client = REDIS_IS_CLUSTER
    ? new Redis.Cluster(CLUSTER_NODES, CLUSTER_OPTIONS)
    : new Redis(REDIS_URL, STANDALONE_OPTIONS);
  attachListeners(client, name);
  return client;
}

// General-purpose client: fanout, presence, caches.
// Cluster when REDIS_CLUSTER_NODES is set, standalone otherwise.
const redis = createMainClient('main');

// Auth-only client: JWT deny-list + auth rate-limit counters.
// Always standalone via REDIS_AUTH_URL — never a cluster client — so auth
// checks are isolated from cluster rebalancing, slot redirects, and the heavy
// fanout pipeline traffic on the main client.
const redisAuth = createStandaloneClient('auth', REDIS_AUTH_URL);

// Search-only client: Meilisearch stream operations and locks.
// Always standalone via REDIS_SEARCH_URL — isolated from main client noise.
const redisSearch = createStandaloneClient('search', REDIS_SEARCH_URL);

// Dedicated subscriber – used by ws/fanout; cannot issue normal commands.
//
// enableReadyCheck must be false for BOTH standalone and cluster subscriber
// connections. After a connection enters subscriber mode (SSUBSCRIBE/SUBSCRIBE),
// Redis rejects INFO commands on that connection. ioredis would attempt to run
// INFO as a ready-check on reconnect, hitting an error and stalling recovery.
// Disabling enableReadyCheck skips that check and lets the reconnected subscriber
// re-subscribe immediately.
const SUB_STANDALONE_OPTIONS = {
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

const SUB_CLUSTER_NODE_OPTIONS = {
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

const redisSub = REDIS_IS_CLUSTER
  ? new Redis.Cluster(CLUSTER_NODES, {
      redisOptions: { ...SUB_CLUSTER_NODE_OPTIONS, ...clusterAuth },
      clusterRetryStrategy: (times: number) => Math.min(times * 100, 3000),
    })
  : new Redis(REDIS_URL, SUB_STANDALONE_OPTIONS);
attachListeners(redisSub, 'subscriber');

// ---------------------------------------------------------------------------
// Pub/Sub helpers
//
// Cluster mode uses sharded pub/sub (SSUBSCRIBE / SPUBLISH / "smessage" event)
// so each channel maps to exactly one shard — hot channels don't saturate
// ---------------------------------------------------------------------------

/** Event name emitted on redisSub when a message arrives. */
const REDIS_PUBSUB_EVENT: string = REDIS_IS_CLUSTER ? 'smessage' : 'message';

function redisPubsubSubscribe(channel: string): Promise<unknown> {
  if (REDIS_IS_CLUSTER) {
    return redisSub.ssubscribe(channel);
  }
  // Standalone mode: user/community fanout is backed by shared shard feeds,
  // but channel/conversation fanout still publishes on the direct topic.
  if (
    channel.startsWith('userfeed:')
    || channel.startsWith('userfeed_worker:')
    || channel.startsWith('communityfeed:')
    || channel.startsWith('channel:')
    || channel.startsWith('conversation:')
  ) {
    return redisSub.subscribe(channel);
  }
  return Promise.resolve();
}

function redisPubsubSubscribableChannels(channels: string[]): string[] {
  const values = Array.isArray(channels) ? channels : [];
  if (REDIS_IS_CLUSTER) {
    return values.filter((channel) => typeof channel === 'string' && channel.trim());
  }
  return values.filter((channel) => (
    typeof channel === 'string'
    && (
      channel.startsWith('userfeed:')
      || channel.startsWith('userfeed_worker:')
      || channel.startsWith('communityfeed:')
      || channel.startsWith('channel:')
      || channel.startsWith('conversation:')
    )
  ));
}

function redisPubsubSubscribeMany(channels: string[]): Promise<unknown> {
  const uniqueChannels = Array.from(new Set(redisPubsubSubscribableChannels(channels)));
  if (!uniqueChannels.length) return Promise.resolve();
  if (REDIS_IS_CLUSTER) {
    return redisSub.ssubscribe(...uniqueChannels);
  }
  return redisSub.subscribe(...uniqueChannels);
}

function redisPubsubUnsubscribe(channel: string): void {
  if (REDIS_IS_CLUSTER) {
    redisSub.sunsubscribe(channel).catch(() => {});
  } else if (
    channel.startsWith('userfeed:')
    || channel.startsWith('userfeed_worker:')
    || channel.startsWith('communityfeed:')
    || channel.startsWith('channel:')
    || channel.startsWith('conversation:')
  ) {
    redisSub.unsubscribe(channel).catch(() => {});
  }
}

async function closeRedisConnections() {
  await Promise.allSettled([
    redis.quit(),
    redisAuth.quit(),
    redisSearch.quit(),
    redisSub.quit(),
  ]);
}

module.exports = redis;
module.exports.redisAuth            = redisAuth;
module.exports.redisSearch          = redisSearch;
module.exports.redisSub             = redisSub;
module.exports.REDIS_IS_CLUSTER     = REDIS_IS_CLUSTER;
module.exports.REDIS_PUBSUB_EVENT   = REDIS_PUBSUB_EVENT;
module.exports.redisPubsubSubscribe = redisPubsubSubscribe;
module.exports.redisPubsubSubscribeMany = redisPubsubSubscribeMany;
module.exports.redisPubsubUnsubscribe = redisPubsubUnsubscribe;
module.exports.closeRedisConnections = closeRedisConnections;
