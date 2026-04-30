
const fanout = require('./fanout');

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

async function publishUserFeedTargets(userTargets, payload) {
  const { userIds } = splitUserTargets(userTargets);
  if (!userIds.length) return;

  const shardGroups = new Map();
  for (const userId of userIds) {
    const shardChannel = userFeedRedisChannelForUserId(userId);
    if (!shardGroups.has(shardChannel)) shardGroups.set(shardChannel, []);
    shardGroups.get(shardChannel).push(userId);
  }

  const batch = Array.from(shardGroups.entries()).map(([shardChannel, shardUserIds]) => ({
    channel: shardChannel,
    payload: userFeedEnvelope(shardUserIds, payload),
  }));
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
  runWithConcurrencyLimit,
  splitUserTargets,
  userFeedEnvelope,
  userFeedRedisChannelForUserId,
  userIdFromTarget,
};
