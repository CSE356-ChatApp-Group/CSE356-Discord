/**
 * Conversations list Redis cache, in-process singleflight map, and row helpers.
 */

const redis = require('../db/redis');
const { staleCacheKey } = require('../utils/distributedSingleflight');

const CONVERSATIONS_CACHE_TTL_SECS = 15;

function conversationsCacheKey(userId: string) {
  return `conversations:list:${userId}`;
}

async function invalidateConversationsListCaches(userIds) {
  const keys = [...new Set(
    (Array.isArray(userIds) ? userIds : [])
      .filter((userId) => typeof userId === 'string' && userId)
      .flatMap((userId) => {
        const key = conversationsCacheKey(userId);
        return [key, staleCacheKey(key)];
      })
  )];
  if (!keys.length) return;
  await redis.del(...keys);
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
