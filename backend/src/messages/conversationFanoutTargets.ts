'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const {
  fanoutTargetCacheTotal,
  conversationFanoutTargetsCacheVersionRetryTotal,
} = require('../utils/metrics');

const rawConversationFanoutTargetsCacheTtl = Number(
  process.env.CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS || '180',
);
const CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS =
  Number.isFinite(rawConversationFanoutTargetsCacheTtl) && rawConversationFanoutTargetsCacheTtl > 0
    ? Math.floor(rawConversationFanoutTargetsCacheTtl)
    : 180;
const conversationFanoutTargetsInflight: Map<string, Promise<string[]>> = new Map();

function conversationFanoutTargetsCacheKey(conversationId: string) {
  return `conversation:${conversationId}:fanout_targets`;
}

/** Bumped (with cache DEL) so in-flight PG loads cannot repopulate stale fanout after membership changes. */
function conversationFanoutTargetsVersionKey(conversationId: string) {
  return `conversation:${conversationId}:fanout_targets_v`;
}

async function invalidateConversationFanoutTargetsCache(conversationId: string) {
  const cacheKey = conversationFanoutTargetsCacheKey(conversationId);
  const versionKey = conversationFanoutTargetsVersionKey(conversationId);
  try {
    const p = redis.pipeline();
    p.del(cacheKey);
    p.incr(versionKey);
    await p.exec();
  } catch {
    await redis.del(cacheKey).catch(() => {});
    await redis.incr(versionKey).catch(() => {});
  }
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
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'hit' });
        return parsed.filter((value) => typeof value === 'string');
      }
    } catch {
      // Ignore parse failures and repopulate from Postgres below.
    }
    redis.del(cacheKey).catch(() => {});
  }

  if (conversationFanoutTargetsInflight.has(cacheKey)) {
    fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'coalesced' });
    return conversationFanoutTargetsInflight.get(cacheKey);
  }

  fanoutTargetCacheTotal.inc({ path: 'conversation_event', result: 'miss' });
  const versionKey = conversationFanoutTargetsVersionKey(conversationId);
  const maxVersionRetries = 8;
  const load = (async () => {
    for (let attempt = 0; attempt < maxVersionRetries; attempt++) {
      const vBeforeQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
      const uniqueTargets = await loadUniqueFanoutTargetsFromDb(conversationId);
      const vAfterQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
      if (vBeforeQuery !== vAfterQuery) {
        conversationFanoutTargetsCacheVersionRetryTotal.inc({ outcome: 'retry' });
        continue;
      }
      redis
        .set(
          cacheKey,
          JSON.stringify(uniqueTargets),
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
