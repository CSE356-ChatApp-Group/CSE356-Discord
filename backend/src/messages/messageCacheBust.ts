/**
 * Redis first-page message cache: DEL + epoch bump so in-flight GET handlers
 * cannot repopulate JSON after another request has busted the cache (same or
 * another API instance).
 */

const { messageCacheBustWallDurationMs } = require('../utils/metrics');

type RedisLike = {
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
};

type PipelineLike = {
  del(...keys: string[]): PipelineLike;
  incr(key: string): PipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
};

type RedisWithPipeline = RedisLike & { pipeline(): PipelineLike };

function redisSupportsPipeline(redis: unknown): redis is RedisWithPipeline {
  return typeof (redis as { pipeline?: unknown }).pipeline === 'function';
}

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

/**
 * DEL list key then INCR epoch in one round-trip when ioredis pipeline is available.
 * Preserves prior semantics: per-command failures are swallowed; whole-pipeline
 * transport errors are swallowed; duration is always observed once per call.
 */
async function bustListAndEpoch(
  redis: RedisLike,
  listKey: string,
  epochKey: string,
  scope: 'channel' | 'conversation'
): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    if (redisSupportsPipeline(redis)) {
      const results = await redis.pipeline().del(listKey).incr(epochKey).exec();
      if (Array.isArray(results)) {
        for (const row of results) {
          if (row && row[0]) {
            /* same as legacy per-command catch: non-fatal */
          }
        }
      }
    } else {
      try {
        await redis.del(listKey);
      } catch {
        /* TTL + epoch backstop */
      }
      try {
        await redis.incr(epochKey);
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal: same as legacy outer behavior for unexpected exec failures */
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    messageCacheBustWallDurationMs.observe({ scope }, ms);
  }
}

export async function bustChannelMessagesCache(
  redis: RedisLike,
  channelId: string | undefined
): Promise<void> {
  if (!channelId) return;
  await bustListAndEpoch(
    redis,
    channelMsgCacheKey(channelId),
    channelMsgCacheEpochKey(channelId),
    'channel'
  );
}

export async function bustConversationMessagesCache(
  redis: RedisLike,
  conversationId: string | undefined
): Promise<void> {
  if (!conversationId) return;
  await bustListAndEpoch(
    redis,
    conversationMsgCacheKey(conversationId),
    conversationMsgCacheEpochKey(conversationId),
    'conversation'
  );
}
