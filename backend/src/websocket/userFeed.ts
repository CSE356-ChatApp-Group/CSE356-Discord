
const fanout = require('./fanout');
const redis = require('../db/redis');
const {
  wsUserfeedPublishCallsTotal,
  wsUserfeedPublishTargetsTotal,
} = require('../utils/metrics');
const { getWorkerLabels } = require('./deliveryTrace');
const {
  connectionSetKey,
  connectionAliveKey,
  connectionOwnerKey,
} = require('./presenceKeys');

const rawUserFeedShardCount = Number(process.env.USER_FEED_SHARD_COUNT || '64');
const USER_FEED_SHARD_COUNT =
  Number.isFinite(rawUserFeedShardCount) && rawUserFeedShardCount > 0
    ? Math.max(1, Math.min(256, Math.floor(rawUserFeedShardCount)))
    : 64;

/**
 * Run async thunks with at most `limit` in flight (shared index pool).
 * Preserves one invocation per job; order of completion is undefined.
 */
async function runWithConcurrencyLimit(jobs, limit) {
  if (!jobs.length) return;
  const cap = Math.min(Math.max(1, limit), jobs.length);
  let nextIndex = 0;
  let firstErr = null;

  async function worker() {
    while (nextIndex < jobs.length && !firstErr) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= jobs.length) return;
      try {
        await jobs[idx]();
      } catch (e) {
        firstErr = firstErr || e;
        break;
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  if (firstErr) throw firstErr;
}

function normalizeUserId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function userIdFromTarget(target) {
  const normalized = normalizeUserId(target);
  if (!normalized) return null;
  if (normalized.startsWith('user:')) {
    return normalizeUserId(normalized.slice(5));
  }
  if (normalized.includes(':')) return null;
  return normalized;
}

function userFeedShardForUserId(userId) {
  const normalized = normalizeUserId(userId) || '';
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % USER_FEED_SHARD_COUNT;
}

function userFeedRedisChannelForUserId(userId) {
  return `userfeed:${userFeedShardForUserId(userId)}`;
}

function userFeedShardLabelForChannel(channel) {
  if (typeof channel !== 'string') return 'unknown';
  const match = /^userfeed:(\d+)$/.exec(channel.trim());
  return match ? match[1] : 'unknown';
}

function userFeedWorkerOwnerId(vm, worker) {
  if (typeof vm !== 'string' || !vm || typeof worker !== 'string' || !worker) return null;
  return `${vm}:${worker}`;
}

function userFeedWorkerChannelForOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId) return null;
  return `userfeed_worker:${ownerId}`;
}

function userFeedWorkerChannelForLabels(vm, worker) {
  const ownerId = userFeedWorkerOwnerId(vm, worker);
  return ownerId ? userFeedWorkerChannelForOwner(ownerId) : null;
}

function isUserFeedWorkerChannel(channel) {
  return typeof channel === 'string' && channel.startsWith('userfeed_worker:');
}

function userFeedRouteLabelForChannel(channel) {
  if (isUserFeedWorkerChannel(channel)) {
    return channel.slice('userfeed_worker:'.length) || 'unknown';
  }
  return userFeedShardLabelForChannel(channel);
}

function workerOwnerHashKey(userId) {
  return `user:${userId}:worker_owners`;
}

async function resolveWorkerOwnedUsers(userIds) {
  const pipeline = redis.pipeline();
  for (const userId of userIds) {
    pipeline.hkeys(workerOwnerHashKey(userId));
  }
  const results = await pipeline.exec();
  const byChannel = new Map();
  const unmatched = [];

  for (let i = 0; i < userIds.length; i += 1) {
    const userId = userIds[i];
    const rawOwners = Array.isArray(results?.[i]?.[1]) ? results[i][1] : [];
    const owners = Array.from(new Set(rawOwners.filter((value) => typeof value === 'string' && value)));
    if (!owners.length) {
      unmatched.push(userId);
      continue;
    }
    for (const ownerId of owners) {
      const channel = userFeedWorkerChannelForOwner(ownerId);
      if (!channel) continue;
      if (!byChannel.has(channel)) byChannel.set(channel, []);
      byChannel.get(channel).push(userId);
    }
  }

  return { byChannel, unmatched };
}

async function resolveLiveWorkerOwnedUsers(userIds) {
  if (!userIds.length) {
    return { byChannel: new Map(), unmatched: [] };
  }

  const connectionPipe = redis.pipeline();
  for (const userId of userIds) {
    connectionPipe.smembers(connectionSetKey(userId));
  }
  const connectionResults = await connectionPipe.exec();
  const connectionIdsByUser = userIds.map((userId, index) => ({
    userId,
    connectionIds: Array.isArray(connectionResults?.[index]?.[1]) ? connectionResults[index][1] : [],
  }));

  const ownerPipe = redis.pipeline();
  const ownerLookups = [];
  for (const { userId, connectionIds } of connectionIdsByUser) {
    for (const connectionId of connectionIds) {
      ownerPipe.exists(connectionAliveKey(userId, connectionId));
      ownerPipe.get(connectionOwnerKey(userId, connectionId));
      ownerLookups.push({ userId });
    }
  }
  const ownerResults = ownerLookups.length ? await ownerPipe.exec() : [];

  const ownersByUser = new Map();
  let ownerResultIndex = 0;
  for (const { userId, connectionIds } of connectionIdsByUser) {
    const owners = new Set();
    for (const _connectionId of connectionIds) {
      const aliveResult = ownerResults?.[ownerResultIndex]?.[1];
      ownerResultIndex += 1;
      const ownerResult = ownerResults?.[ownerResultIndex]?.[1];
      ownerResultIndex += 1;
      if (Number(aliveResult || 0) !== 1) continue;
      if (typeof ownerResult === 'string' && ownerResult) {
        owners.add(ownerResult);
      }
    }
    if (owners.size) {
      ownersByUser.set(userId, Array.from(owners));
    }
  }

  const byChannel = new Map();
  const unmatched = [];
  for (const userId of userIds) {
    const owners = ownersByUser.get(userId) || [];
    if (!owners.length) {
      unmatched.push(userId);
      continue;
    }
    for (const ownerId of owners) {
      const channel = userFeedWorkerChannelForOwner(ownerId);
      if (!channel) continue;
      if (!byChannel.has(channel)) byChannel.set(channel, []);
      byChannel.get(channel).push(userId);
    }
  }

  return { byChannel, unmatched };
}

function allUserFeedRedisChannels() {
  return Array.from(
    { length: USER_FEED_SHARD_COUNT },
    (_unused, shardIndex) => `userfeed:${shardIndex}`,
  );
}

function userFeedEnvelope(userIds, payload) {
  return {
    __wsRoute: {
      kind: 'users',
      userIds,
    },
    payload,
  };
}

function splitUserTargets(targets) {
  const userIds = [];
  const passthroughTargets = [];
  const seenUserIds = new Set();
  const seenTargets = new Set();

  for (const target of Array.isArray(targets) ? targets : []) {
    const userId = userIdFromTarget(target);
    if (userId) {
      if (!seenUserIds.has(userId)) {
        seenUserIds.add(userId);
        userIds.push(userId);
      }
      continue;
    }

    if (typeof target !== 'string' || !target.trim() || seenTargets.has(target)) continue;
    seenTargets.add(target);
    passthroughTargets.push(target);
  }

  return { userIds, passthroughTargets };
}

async function publishUserFeedTargets(userTargets, payload, { preferLiveOwners = false } = {}) {
  const { userIds } = splitUserTargets(userTargets);
  if (!userIds.length) return;

  const workerOwned = preferLiveOwners
    ? await resolveLiveWorkerOwnedUsers(userIds)
    : await resolveWorkerOwnedUsers(userIds);
  const shardGroups = new Map(workerOwned.byChannel);
  for (const userId of workerOwned.unmatched) {
    const shardChannel = userFeedRedisChannelForUserId(userId);
    if (!shardGroups.has(shardChannel)) shardGroups.set(shardChannel, []);
    shardGroups.get(shardChannel).push(userId);
  }

  const batch = Array.from(shardGroups.entries()).map(([shardChannel, shardUserIds]) => ({
    channel: shardChannel,
    payload: userFeedEnvelope(shardUserIds, payload),
  }));
  const labels = getWorkerLabels();
  for (const [shardChannel, shardUserIds] of shardGroups.entries()) {
    const shard = userFeedRouteLabelForChannel(shardChannel);
    wsUserfeedPublishCallsTotal?.inc?.({ shard, vm: labels.vm, worker: labels.worker });
    wsUserfeedPublishTargetsTotal?.inc?.(
      { shard, vm: labels.vm, worker: labels.worker },
      shardUserIds.length,
    );
  }
  await fanout.publishBatch(batch);
}

function isUserFeedEnvelope(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.__wsRoute &&
    value.__wsRoute.kind === 'users' &&
    Array.isArray(value.__wsRoute.userIds) &&
    value.payload &&
    typeof value.payload === 'object' &&
    !Array.isArray(value.payload)
  );
}

module.exports = {
  allUserFeedRedisChannels,
  USER_FEED_SHARD_COUNT,
  isUserFeedEnvelope,
  publishUserFeedTargets,
  resolveLiveWorkerOwnedUsers,
  runWithConcurrencyLimit,
  splitUserTargets,
  userFeedEnvelope,
  userFeedRedisChannelForUserId,
  userFeedRouteLabelForChannel,
  userFeedWorkerChannelForLabels,
  userFeedWorkerChannelForOwner,
  userFeedWorkerOwnerId,
  isUserFeedWorkerChannel,
  userFeedShardLabelForChannel,
  userIdFromTarget,
};
