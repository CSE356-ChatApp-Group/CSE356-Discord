'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const { fanoutTargetCacheTotal } = require('../utils/metrics');

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

async function invalidateConversationFanoutTargetsCache(conversationId: string) {
  await redis.del(conversationFanoutTargetsCacheKey(conversationId));
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
  const load = (async () => {
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
    const uniqueTargets = [...new Set(targets)];
    redis
      .set(
        cacheKey,
        JSON.stringify(uniqueTargets),
        'EX',
        CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS,
      )
      .catch(() => {});
    return uniqueTargets;
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
