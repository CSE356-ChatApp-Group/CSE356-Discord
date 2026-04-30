
const { query } = require('../db/pool');
const redis = require('../db/redis');
const {
  fanoutTargetCacheTotal,
  conversationFanoutTargetsCacheVersionRetryTotal,
} = require('../utils/metrics');
const {
  conversationFanoutConfig: {
    CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS,
  },
} = require('./conversationFanoutConfig');
const {
  readVersionedCacheState,
  invalidateVersionedCache,
} = require('./fanoutCacheStoreUtils');
const conversationFanoutTargetsInflight: Map<string, Promise<string[]>> = new Map();

function conversationFanoutTargetsCacheKey(conversationId: string) {
  return `conversation:${conversationId}:fanout_targets`;
}

/** Bumped (with cache DEL) so in-flight PG loads cannot repopulate stale fanout after membership changes. */
function conversationFanoutTargetsVersionKey(conversationId: string) {
  return `conversation:${conversationId}:fanout_targets_v`;
}

function parseConversationFanoutTargetsCached(
  conversationId: string,
  cached: string,
): string[] | null {
  try {
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed)) {
      return parsed.filter((value: unknown) => typeof value === 'string');
    }
    if (
      parsed
      && typeof parsed === 'object'
      && (parsed as { v?: unknown; u?: unknown }).v === 2
      && Array.isArray((parsed as { u?: unknown }).u)
    ) {
      const users = (parsed as { u: string[] }).u.filter(
        (id: unknown) => typeof id === 'string' && id.length > 0,
      );
      return [`conversation:${conversationId}`, ...users.map((id: string) => `user:${id}`)];
    }
  } catch {
    return null;
  }
  return null;
}

async function invalidateConversationFanoutTargetsCache(conversationId: string) {
  const cacheKey = conversationFanoutTargetsCacheKey(conversationId);
  const versionKey = conversationFanoutTargetsVersionKey(conversationId);
  await invalidateVersionedCache(cacheKey, versionKey);
}

async function loadUniqueFanoutTargetsFromDb(conversationId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT user_id::text AS user_id
     FROM conversation_participants
     WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId],
  );
  const targets = [
    `conversation:${conversationId}`,
    ...rows.map((row) => `user:${row.user_id}`),
  ];
  return [...new Set(targets)];
}

async function getConversationFanoutTargets(conversationId: string): Promise<string[]> {
  const cacheKey = conversationFanoutTargetsCacheKey(conversationId);
  const versionKey = conversationFanoutTargetsVersionKey(conversationId);
  const { cached, version: cachedVersion } = await readVersionedCacheState(cacheKey, versionKey);
  if (cached) {
    const fromCache = parseConversationFanoutTargetsCached(conversationId, cached);
    if (fromCache !== null) {
      fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'hit' });
      return fromCache;
    }
    redis.del(cacheKey).catch(() => {});
  }

  if (conversationFanoutTargetsInflight.has(cacheKey)) {
    fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'coalesced' });
    return conversationFanoutTargetsInflight.get(cacheKey);
  }

  fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'miss' });
  const maxVersionRetries = 8;
  const load = (async () => {
    for (let attempt = 0; attempt < maxVersionRetries; attempt++) {
      const vBeforeQuery = attempt === 0
        ? Number(cachedVersion || 0)
        : Number((await redis.get(versionKey).catch(() => null)) || 0);
      const uniqueTargets = await loadUniqueFanoutTargetsFromDb(conversationId);
      const vAfterQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
      if (vBeforeQuery !== vAfterQuery) {
        conversationFanoutTargetsCacheVersionRetryTotal.inc({ outcome: 'retry' });
        continue;
      }
      const userIds = uniqueTargets
        .filter((t) => typeof t === 'string' && t.startsWith('user:'))
        .map((t) => t.slice('user:'.length));
      const compact = { v: 2 as const, u: userIds };
      redis
        .set(
          cacheKey,
          JSON.stringify(compact),
          'EX',
          CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS,
        )
        .catch(() => {});
      return uniqueTargets;
    }
    conversationFanoutTargetsCacheVersionRetryTotal.inc({ outcome: 'uncached_return' });
    return loadUniqueFanoutTargetsFromDb(conversationId);
  })().finally(() => {
    conversationFanoutTargetsInflight.delete(cacheKey);
  });

  conversationFanoutTargetsInflight.set(cacheKey, load);
  return load;
}

module.exports = {
  getConversationFanoutTargets,
  invalidateConversationFanoutTargetsCache,
};
