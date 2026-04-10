/**
 * Redis first-page message cache: DEL + epoch bump so in-flight GET handlers
 * cannot repopulate JSON after another request has busted the cache (same or
 * another API instance).
 */
'use strict';

function channelMsgCacheKey(channelId) {
  return `messages:channel:${channelId}`;
}

function conversationMsgCacheKey(conversationId) {
  return `messages:conversation:${conversationId}`;
}

function channelMsgCacheEpochKey(channelId) {
  return `messages:channel:${channelId}:cacheEpoch`;
}

function conversationMsgCacheEpochKey(conversationId) {
  return `messages:conversation:${conversationId}:cacheEpoch`;
}

async function readMessageCacheEpoch(redis, epochKey) {
  try {
    const v = await redis.get(epochKey);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function bustChannelMessagesCache(redis, channelId) {
  if (!channelId) return;
  try {
    await redis.del(channelMsgCacheKey(channelId));
  } catch {
    /* TTL + epoch backstop */
  }
  try {
    await redis.incr(channelMsgCacheEpochKey(channelId));
  } catch {
    /* non-fatal */
  }
}

async function bustConversationMessagesCache(redis, conversationId) {
  if (!conversationId) return;
  try {
    await redis.del(conversationMsgCacheKey(conversationId));
  } catch {
    /* TTL + epoch backstop */
  }
  try {
    await redis.incr(conversationMsgCacheEpochKey(conversationId));
  } catch {
    /* non-fatal */
  }
}

module.exports = {
  channelMsgCacheKey,
  conversationMsgCacheKey,
  channelMsgCacheEpochKey,
  conversationMsgCacheEpochKey,
  readMessageCacheEpoch,
  bustChannelMessagesCache,
  bustConversationMessagesCache,
};
