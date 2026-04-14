/**
 * Redis first-page message cache: DEL + epoch bump so in-flight GET handlers
 * cannot repopulate JSON after another request has busted the cache (same or
 * another API instance).
 */

type RedisLike = {
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  scan?(cursor: string, ...args: string[]): Promise<[string, string[]]>;
};

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

type MessageCacheKeyOptions = {
  limit?: number;
  epoch?: number;
};

export function channelMsgCacheKey(channelId: string, options: MessageCacheKeyOptions = {}): string {
  const parts = [`messages:channel:${channelId}`];
  if (typeof options.epoch === 'number') parts.push(`v${Math.max(0, Math.trunc(options.epoch))}`);
  if (typeof options.limit === 'number') parts.push(`l${normalizeLimit(options.limit)}`);
  return parts.join(':');
}

export function conversationMsgCacheKey(conversationId: string, options: MessageCacheKeyOptions = {}): string {
  const parts = [`messages:conversation:${conversationId}`];
  if (typeof options.epoch === 'number') parts.push(`v${Math.max(0, Math.trunc(options.epoch))}`);
  if (typeof options.limit === 'number') parts.push(`l${normalizeLimit(options.limit)}`);
  return parts.join(':');
}

export function channelMsgCacheEpochKey(channelId: string): string {
  return `messages:channel:${channelId}:cacheEpoch`;
}

export function conversationMsgCacheEpochKey(conversationId: string): string {
  return `messages:conversation:${conversationId}:cacheEpoch`;
}

async function deleteByPrefix(redis: RedisLike, prefix: string): Promise<void> {
  if (typeof redis.scan !== 'function') return;
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', '200');
    if (Array.isArray(keys) && keys.length > 0) {
      await redis.del(...keys);
    }
    cursor = nextCursor;
  } while (cursor !== '0');
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
    // If INCR fails below, this still clears known versioned/limit variants.
    await deleteByPrefix(redis, channelMsgCacheKey(channelId));
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
    // If INCR fails below, this still clears known versioned/limit variants.
    await deleteByPrefix(redis, conversationMsgCacheKey(conversationId));
  } catch {
    /* TTL + epoch backstop */
  }
  try {
    await redis.incr(conversationMsgCacheEpochKey(conversationId));
  } catch {
    /* non-fatal */
  }
}
