/**
 * Conversations list Redis cache, in-process singleflight map, and row helpers.
 */

const redis = require('../db/redis');
const { redisBatchUnlink } = require('../db/redisBatch');
const { staleCacheKey } = require('../utils/distributedSingleflight');
const { recordEndpointListCacheInvalidation } = require('../utils/endpointCacheMetrics');

// Aligns with CHANNELS_LIST_CACHE_TTL_SECS pattern (channelRouterShared.ts).
// Structural bust only from conversation routes / side effects — not per-message fanout.
const _convListTtl = parseInt(process.env.CONVERSATIONS_LIST_CACHE_TTL_SECS || '60', 10);
const CONVERSATIONS_CACHE_TTL_SECS =
  Number.isFinite(_convListTtl) && _convListTtl > 0 ? _convListTtl : 60;

function conversationsCacheKey(userId: string) {
  return `conversations:list:${userId}`;
}

// TODO(last-message-preview): New messages no longer bust this key; previews/unreads may lag until
// TTL unless clients rely on WS overlays or a future narrow invalidation hook.

async function invalidateConversationsListCaches(userIds, reason: string = 'structural_conversation_change') {
  const normalized = [...new Set(
    (Array.isArray(userIds) ? userIds : [])
      .filter((userId) => typeof userId === 'string' && userId)
  )];
  const keys = [...new Set(
    normalized.flatMap((userId) => {
      const key = conversationsCacheKey(userId);
      return [key, staleCacheKey(key)];
    })
  )];
  if (!keys.length) return;
  recordEndpointListCacheInvalidation('conversations', reason);
  await redisBatchUnlink(redis, keys);
}

// In-process singleflight: prevents thundering-herd on cache expiry.
const conversationsInflight: Map<string, Promise<{ conversations: any[] }>> = new Map();

function applyConversationLastMessageMetadata(conversations, latestByConversation) {
  if (!Array.isArray(conversations) || !conversations.length || !latestByConversation?.size) return;
  for (const c of conversations) {
    const latest = latestByConversation.get(c.id);
    if (!latest) continue;
    c.last_message_id = latest.msg_id;
    c.last_message_author_id = latest.author_id || null;
    c.last_message_at = latest.at || null;
  }
}

function sortConversationRowsByLatest(rows) {
  const toMillis = (value) => {
    const ms = new Date(value || 0).getTime();
    return Number.isFinite(ms) ? ms : 0;
  };
  rows.sort((a, b) => {
    const aTs = toMillis(a.last_message_at || a.updated_at);
    const bTs = toMillis(b.last_message_at || b.updated_at);
    if (aTs !== bTs) return bTs - aTs;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
}

module.exports = {
  CONVERSATIONS_CACHE_TTL_SECS,
  conversationsCacheKey,
  invalidateConversationsListCaches,
  conversationsInflight,
  applyConversationLastMessageMetadata,
  sortConversationRowsByLatest,
};
