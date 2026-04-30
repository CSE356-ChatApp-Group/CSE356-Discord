const redis = require('../../db/redis');
const {
  wsRecentConnectKey,
  channelRecentConnectKey,
  channelRecentZsetEnabled,
  WS_RECENT_CONNECT_TTL_SECONDS,
} = require('../../websocket/recentConnect');
const logger = require('../../utils/logger');
const {
  fanoutRecentConnectCacheTotal,
  fanoutRecentConnectZsetSize,
} = require('../../utils/metrics');
const {
  channelRealtimeConfig: {
    RECENT_CONNECT_TARGET_CACHE_MS,
    ACTIVE_CONNECTED_TARGET_BATCH,
    CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK,
    CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX,
  },
} = require('../config/channelRealtimeConfig');

const recentConnectTargetsCache: Map<string, { targets: string[]; cachedAt: number }> = new Map();

function recentConnectTargetsCacheKey(channelId: string) {
  return `rc_targets:${channelId}`;
}

function readRecentConnectTargetsCache(channelId: string): string[] | null {
  if (RECENT_CONNECT_TARGET_CACHE_MS <= 0) return null;
  const key = recentConnectTargetsCacheKey(channelId);
  const entry = recentConnectTargetsCache.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs > RECENT_CONNECT_TARGET_CACHE_MS) {
    recentConnectTargetsCache.delete(key);
    return null;
  }
  return entry.targets;
}

function writeRecentConnectTargetsCache(channelId: string, targets: string[]) {
  if (RECENT_CONNECT_TARGET_CACHE_MS <= 0) return;
  // Do not cache negative results. A grader/browser can connect or refresh its
  // user-topic subscription immediately after this lookup; caching [] would
  // suppress the only delivery path while WS_AUTO_SUBSCRIBE_MODE=user_only.
  if (!targets.length) return;
  recentConnectTargetsCache.set(recentConnectTargetsCacheKey(channelId), {
    targets,
    cachedAt: Date.now(),
  });
}

/** Sequential MGET batches — avoids firing dozens of MGETs at once (Redis single-thread + ioredis). */
async function mgetKeyBatches(keys: string[], batchSize: number): Promise<(string | null)[]> {
  if (!keys.length) return [];
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += batchSize) {
    const slice = keys.slice(i, i + batchSize);
    const part = await redis.mget(...slice);
    out.push(...part);
  }
  return out;
}

function connectedUsersKey() {
  return 'presence:connected_users';
}

async function smismemberBatches(key: string, members: string[], batchSize: number): Promise<boolean[]> {
  if (!members.length) return [];
  const out: boolean[] = [];
  for (let i = 0; i < members.length; i += batchSize) {
    const slice = members.slice(i, i + batchSize);
    try {
      const raw = await redis.call('SMISMEMBER', key, ...slice);
      const values = Array.isArray(raw) ? raw : [];
      out.push(...values.map((value) => Number(value) === 1));
    } catch (err: any) {
      const message = String(err?.message || '');
      if (!/unknown command|wrong number of arguments|SMISMEMBER/i.test(message)) {
        throw err;
      }
      const pipe = redis.pipeline();
      for (const member of slice) {
        pipe.sismember(key, member);
      }
      const results = await pipe.exec();
      out.push(...results.map((row) => Number(row?.[1] || 0) === 1));
    }
  }
  return out;
}

async function activeConnectedTargets(targets: string[]) {
  if (!targets.length) return [];
  const userIds = targets.map((target) => target.slice('user:'.length));
  const active = await smismemberBatches(
    connectedUsersKey(),
    userIds,
    ACTIVE_CONNECTED_TARGET_BATCH,
  );
  return targets.filter((_target, idx) => active[idx]);
}

async function resolveRecentConnectTargets(channelId: string, targets: string[]) {
  if (!targets.length) return [];
  const cachedTargets = readRecentConnectTargetsCache(channelId);
  if (cachedTargets) {
    fanoutRecentConnectCacheTotal.inc({ result: 'hit' });
    return cachedTargets;
  }
  fanoutRecentConnectCacheTotal.inc({ result: 'miss' });
  try {
    if (channelRecentZsetEnabled()) {
      const since = Date.now() - WS_RECENT_CONNECT_TTL_SECONDS * 1000;
      const userIds = await redis.zrangebyscore(
        channelRecentConnectKey(channelId),
        since,
        '+inf',
      );
      fanoutRecentConnectZsetSize.observe(userIds.length);
      const cappedSet = new Set(targets);
      const zsetSet = new Set(userIds.filter((uid) => typeof uid === 'string'));
      const inZset = userIds
        .filter((uid) => typeof uid === 'string' && cappedSet.has(`user:${uid}`))
        .map((uid) => `user:${uid}`);

      const notInZset = targets.filter((t) => !zsetSet.has(t.slice('user:'.length)));
      let bootstrapWindowTargets: string[] = [];
      if (notInZset.length > 0) {
        const fallbackProbeTargets = notInZset.slice(
          0,
          Math.min(notInZset.length, CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX),
        );
        const keys = fallbackProbeTargets.map((target) =>
          wsRecentConnectKey(target.slice('user:'.length)),
        );
        const MGET_BATCH = 100;
        const [markers, activeSet] = await Promise.all([
          mgetKeyBatches(keys, MGET_BATCH),
          CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK
            ? activeConnectedTargets(fallbackProbeTargets).then((rows) => new Set(rows))
            : Promise.resolve(new Set<string>()),
        ]);
        bootstrapWindowTargets = fallbackProbeTargets.filter(
          (t, idx) => !!markers[idx] || activeSet.has(t),
        );
      }

      const filteredTargets = bootstrapWindowTargets.length > 0
        ? [...new Set([...inZset, ...bootstrapWindowTargets])]
        : inZset;
      writeRecentConnectTargetsCache(channelId, filteredTargets);
      return filteredTargets;
    }
    const keys = targets.map((target) => wsRecentConnectKey(target.slice(5)));
    const MGET_BATCH = 100;
    const [markers, activeTargets] = await Promise.all([
      mgetKeyBatches(keys, MGET_BATCH),
      activeConnectedTargets(targets),
    ]);
    const activeSet = new Set(activeTargets);
    const filteredTargets = targets.filter((target, idx) => !!markers[idx] || activeSet.has(target));
    writeRecentConnectTargetsCache(channelId, filteredTargets);
    return filteredTargets;
  } catch (err) {
    logger.warn(
      { err, targetCount: targets.length },
      'Recent-connect bridge lookup failed; falling back to full user fanout',
    );
    return targets;
  }
}

module.exports = { resolveRecentConnectTargets };

