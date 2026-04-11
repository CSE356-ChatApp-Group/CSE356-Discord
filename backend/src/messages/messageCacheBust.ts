/**
 * Redis first-page message cache: DEL + epoch bump so in-flight GET handlers
 * cannot repopulate JSON after another request has busted the cache (same or
 * another API instance).
 */

type RedisLike = {
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
};

export function channelMsgCacheKey(channelId: string): string {
  return `messages:channel:${channelId}`;
}

export function conversationMsgCacheKey(conversationId: string): string {
  return `messages:conversation:${conversationId}`;
}

export function channelMsgCacheEpochKey(channelId: string): string {
  return `messages:channel:${channelId}:cacheEpoch`;
}

export function conversationMsgCacheEpochKey(conversationId: string): string {
  return `messages:conversation:${conversationId}:cacheEpoch`;
}

export async function readMessageCacheEpoch(
  redis: RedisLike,
  epochKey: string
): Promise<number> {
  try {
    const v = await redis.get(epochKey);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function bustChannelMessagesCache(
  redis: RedisLike,
  channelId: string | undefined
): Promise<void> {
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

export async function bustConversationMessagesCache(
  redis: RedisLike,
  conversationId: string | undefined
): Promise<void> {
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
