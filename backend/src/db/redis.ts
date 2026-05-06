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

const Redis = require("ioredis");
const logger = require("../utils/logger");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const REDIS_AUTH_URL = process.env.REDIS_AUTH_URL || REDIS_URL;

// Comma-separated "host:port" list. When set, redis + redisSub run in cluster mode.
// redisAuth always uses REDIS_AUTH_URL (standalone) regardless of this setting.
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES || "";

const REDIS_IS_CLUSTER = Boolean(REDIS_CLUSTER_NODES.trim());

function parseClusterNodes(nodesStr: string) {
  return nodesStr.split(",").map((s) => {
    const trimmed = s.trim();
    const colonIdx = trimmed.lastIndexOf(":");
    const host = colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
    const port =
      colonIdx > 0 ? parseInt(trimmed.slice(colonIdx + 1), 10) : 7001;
    return { host, port };
  });
}

const CLUSTER_NODES = REDIS_IS_CLUSTER
  ? parseClusterNodes(REDIS_CLUSTER_NODES)
  : [];

const STANDALONE_OPTIONS = {
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
};

const CLUSTER_OPTIONS = {
  redisOptions: STANDALONE_OPTIONS,
  clusterRetryStrategy: (times: number) => Math.min(times * 100, 3000),
};

function attachListeners(client: any, name: string) {
  client.on("connect", () => logger.info({ client: name }, "Redis connected"));
  client.on("ready", () => logger.info({ client: name }, "Redis ready"));
  client.on("reconnecting", () =>
    logger.warn({ client: name }, "Redis reconnecting"),
  );
  client.on("error", (err: Error) =>
    logger.error({ err, client: name }, "Redis error"),
  );
  client.on("end", () =>
    logger.info({ client: name }, "Redis connection ended"),
  );
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
const redis = createMainClient("main");

// Auth-only client: JWT deny-list + auth rate-limit counters.
// Always standalone via REDIS_AUTH_URL — never a cluster client — so auth
// checks are isolated from cluster rebalancing, slot redirects, and the heavy
// fanout pipeline traffic on the main client.
const redisAuth = createStandaloneClient("auth", REDIS_AUTH_URL);

// Dedicated subscriber – used by ws/fanout; cannot issue normal commands.
//
// Standalone: enableReadyCheck must be false because ioredis runs INFO as its
// ready-check, but INFO is not allowed on a connection that is (or has
// previously been) in subscriber mode, causing an immediate error.
//
// Cluster: node connections can have enableReadyCheck: true because ioredis
// Cluster manages multiple connections and needs to be able to run CLUSTER
// SLOTS / INFO on at least one of them to maintain the slot map. node-level
// ready checks are safe during initial connection before the connection
// enters subscriber mode.
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
      redisOptions: SUB_STANDALONE_OPTIONS,
      clusterRetryStrategy: (times: number) => Math.min(times * 100, 3000),
    })
  : new Redis(REDIS_URL, SUB_STANDALONE_OPTIONS);
attachListeners(redisSub, "subscriber");

// ---------------------------------------------------------------------------
// Pub/Sub helpers
//
// Cluster mode uses sharded pub/sub (SSUBSCRIBE / SPUBLISH / "smessage" event)
// so each channel maps to exactly one shard — hot channels don't saturate
// every node. Standalone keeps classic SUBSCRIBE / PUBLISH / "message".
// ---------------------------------------------------------------------------

/** Event name emitted on redisSub when a message arrives. */
const REDIS_PUBSUB_EVENT: string = REDIS_IS_CLUSTER ? "smessage" : "message";

function redisPubsubSubscribe(channel: string): Promise<unknown> {
  return REDIS_IS_CLUSTER
    ? redisSub.ssubscribe(channel)
    : redisSub.subscribe(channel);
}

function redisPubsubUnsubscribe(channel: string): void {
  if (REDIS_IS_CLUSTER) {
    redisSub.sunsubscribe(channel).catch(() => {});
  } else {
    redisSub.unsubscribe(channel).catch(() => {});
  }
}

async function closeRedisConnections() {
  await Promise.allSettled([redis.quit(), redisAuth.quit(), redisSub.quit()]);
}

module.exports = redis;
module.exports.redisAuth = redisAuth;
module.exports.redisSub = redisSub;
module.exports.REDIS_IS_CLUSTER = REDIS_IS_CLUSTER;
module.exports.REDIS_PUBSUB_EVENT = REDIS_PUBSUB_EVENT;
module.exports.redisPubsubSubscribe = redisPubsubSubscribe;
module.exports.redisPubsubUnsubscribe = redisPubsubUnsubscribe;
module.exports.closeRedisConnections = closeRedisConnections;
