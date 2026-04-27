/**
 * Cross-instance cache stampede protection using Redis locks + stale fallback.
 *
 * Pattern:
 * 1) Try fresh cache.
 * 2) On miss, attempt distributed lock (SET NX PX).
 * 3) Lock holder computes + writes cache.
 * 4) Other instances serve stale (if present) while refresh happens.
 * 5) If no stale, briefly wait for fresh to appear, then fail open to local load.
 */

'use strict';

const crypto = require('crypto');

type JsonRedisLike = {
  get(key: string): Promise<string | null>;
  set(...args: any[]): Promise<unknown>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: any[]): Promise<unknown>;
};

type SingleflightParams<T> = {
  redis: JsonRedisLike;
  cacheKey: string;
  inflight: Map<string, Promise<T>>;
  load: () => Promise<T>;
  readFresh: () => Promise<T | null>;
  readStale?: () => Promise<T | null>;
  lockTtlMs?: number;
  waitForFreshMs?: number;
  pollMs?: number;
};

const DEFAULT_LOCK_TTL_MS = 2_500;
const DEFAULT_WAIT_FOR_FRESH_MS = 800;
const DEFAULT_POLL_MS = 40;
/** Stale companion TTL = ceil(ttl * multiplier); lowered default to cut Redis duplication. */
const DEFAULT_STALE_MULTIPLIER = 2;
const DEFAULT_TTL_JITTER_RATIO = 0.20;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function jitteredTtlSeconds(baseTtlSeconds: number, ratio = DEFAULT_TTL_JITTER_RATIO) {
  const base = clampInt(baseTtlSeconds, 1, 86_400);
  const r = Math.max(0, Math.min(0.95, Number(ratio) || 0));
  if (r === 0) return base;
  const min = Math.max(1, Math.floor(base * (1 - r)));
  const max = Math.max(min, Math.ceil(base * (1 + r)));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function staleCacheKey(cacheKey: string) {
  return `stale:${cacheKey}`;
}

async function getJsonCache<T>(redis: JsonRedisLike, key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      await redis.del(key).catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

type StaleCacheOpts = {
  staleTtlSeconds?: number;
  jitterRatio?: number;
  /** When false, skip `stale:<key>` (saves ~1× JSON for large list caches). */
  writeStale?: boolean;
  /** Overrides DEFAULT_STALE_MULTIPLIER when staleTtlSeconds is not set. */
  staleMultiplier?: number;
  /** Upper bound for stale TTL (seconds). */
  maxStaleTtlSeconds?: number;
};

async function setJsonCacheWithStale(
  redis: JsonRedisLike,
  key: string,
  value: unknown,
  ttlSeconds: number,
  opts: StaleCacheOpts = {},
) {
  const payload = JSON.stringify(value);
  const ttl = jitteredTtlSeconds(ttlSeconds, opts.jitterRatio);
  const mult = Number.isFinite(opts.staleMultiplier as number)
    ? Number(opts.staleMultiplier)
    : DEFAULT_STALE_MULTIPLIER;
  const maxStale = Number.isFinite(opts.maxStaleTtlSeconds as number)
    ? clampInt(Number(opts.maxStaleTtlSeconds), Math.max(ttl + 1, 2), 7 * 24 * 60 * 60)
    : 7 * 24 * 60 * 60;
  const staleTtl = clampInt(
    opts.staleTtlSeconds ?? Math.round(ttlSeconds * mult),
    Math.max(ttl + 1, 2),
    maxStale,
  );
  try {
    await redis.set(key, payload, 'EX', ttl);
  } catch {
    // non-fatal
  }
  if (opts.writeStale === false) {
    return;
  }
  try {
    await redis.set(staleCacheKey(key), payload, 'EX', staleTtl);
  } catch {
    // non-fatal
  }
}

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function releaseLock(redis: JsonRedisLike, lockKey: string, token: string) {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch {
    // non-fatal
  }
}

async function withDistributedSingleflight<T>({
  redis,
  cacheKey,
  inflight,
  load,
  readFresh,
  readStale,
  lockTtlMs = DEFAULT_LOCK_TTL_MS,
  waitForFreshMs = DEFAULT_WAIT_FOR_FRESH_MS,
  pollMs = DEFAULT_POLL_MS,
}: SingleflightParams<T>): Promise<T> {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const run = (async () => {
    const lockKey = `sf:lock:${cacheKey}`;
    const lockToken = crypto.randomUUID();
    let lockAcquired = false;

    try {
      const lock = await redis.set(
        lockKey,
        lockToken,
        'NX',
        'PX',
        clampInt(lockTtlMs, 250, 30_000),
      ).catch(() => null);
      lockAcquired = lock === 'OK';

      if (lockAcquired) {
        return await load();
      }

      if (readStale) {
        const stale = await readStale();
        if (stale !== null) return stale;
      }

      const deadline = Date.now() + clampInt(waitForFreshMs, 100, 5_000);
      const sleepMs = clampInt(pollMs, 10, 250);
      while (Date.now() < deadline) {
        const fresh = await readFresh();
        if (fresh !== null) return fresh;
        await sleep(sleepMs);
      }

      // Fail open: preserve availability even if lock holder crashed.
      return await load();
    } finally {
      if (lockAcquired) {
        await releaseLock(redis, lockKey, lockToken);
      }
    }
  })().finally(() => {
    inflight.delete(cacheKey);
  });

  inflight.set(cacheKey, run);
  return run;
}

module.exports = {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
};
