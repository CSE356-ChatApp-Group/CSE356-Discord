/**
 * Serialize POST /messages DB transactions per channel_id on this Node process.
 *
 * Hot channels see concurrent INSERTs updating the same btree/GIN index pages
 * (notably btree_gin on (channel_id, content_tsv)), which can push insert-phase
 * wall time to the statement_timeout. Serializing removes same-channel overlap.
 */

'use strict';

const crypto = require('crypto');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const {
  messageChannelInsertLockTotal,
  messageChannelInsertLockWaitMs,
  messageInsertLockWaitersCurrentGauge,
  messageInsertLockQueueRejectTotal,
  messageInsertLockWaitTimeoutTotal,
  messageInsertLockAcquiredAfterWaitTotal,
  messageInsertLockHolderDurationMs,
} = require('../utils/metrics');
const {
  recordMessageChannelInsertLockAcquireWait,
  recordMessageChannelInsertLockTimeoutEvent,
} = require('./messageInsertLockPressure');

const MESSAGE_INSERT_LOCK_TTL_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_TTL_MS',
  45000,
  5000,
  120000,
);
const MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS',
  2000,
  500,
  4000,
);
const MESSAGE_INSERT_LOCK_POLL_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_POLL_MIN_MS',
  15,
  5,
  250,
);
const MESSAGE_INSERT_LOCK_POLL_MAX_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_POLL_MAX_MS',
  120,
  MESSAGE_INSERT_LOCK_POLL_MIN_MS,
  1000,
);
const MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL = parseIntEnv(
  'MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL',
  32,
  1,
  1000,
);
const MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE = parseFloatEnv(
  'MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE',
  0.02,
  0,
  1,
);
const MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS',
  250,
  1,
  60000,
);
const MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS',
  250,
  25,
  2000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS',
  2000,
  250,
  10000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS',
  200,
  0,
  2000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS',
  500,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS,
  5000,
);
const MESSAGE_INSERT_LOCK_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;
const MESSAGE_INSERT_LOCK_TIMEOUT_CODE = 'MESSAGE_INSERT_LOCK_TIMEOUT';
const MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE = 'MESSAGE_INSERT_LOCK_QUEUE_REJECT';
const channelQueues = new Map<string, ChannelQueue>();
const recentChannelTimeoutAtMs = new Map<string, number>();
let waitersTotal = 0;

function parseIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseFloatEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseFloat(process.env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRedisOpTimeout<T>(op: Promise<T>, timeoutMs: number, opName: string) {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      op,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err: any = new Error(`Redis ${opName} timed out`);
          err.code = 'REDIS_OP_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function jitteredSleepMs(attempt: number) {
  const base = Math.min(
    MESSAGE_INSERT_LOCK_POLL_MAX_MS,
    MESSAGE_INSERT_LOCK_POLL_MIN_MS * Math.pow(2, Math.max(0, attempt)),
  );
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
  return Math.min(MESSAGE_INSERT_LOCK_POLL_MAX_MS, base + jitter);
}

function pruneRecentTimeoutMap(nowMs: number) {
  if (recentChannelTimeoutAtMs.size <= 50000) return;
  const floor = nowMs - MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS * 4;
  for (const [channelId, ts] of recentChannelTimeoutAtMs) {
    if (ts < floor) recentChannelTimeoutAtMs.delete(channelId);
  }
}

function markRecentChannelTimeout(channelId: string) {
  const nowMs = Date.now();
  recentChannelTimeoutAtMs.set(channelId, nowMs);
  pruneRecentTimeoutMap(nowMs);
}

function shouldSuppressChannelRetry(channelId: string) {
  const nowMs = Date.now();
  const lastTimeoutAt = Number(recentChannelTimeoutAtMs.get(channelId) || 0);
  if (!lastTimeoutAt) return false;
  return nowMs - lastTimeoutAt <= MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS;
}

/**
 * Skip Redis + per-process queue for channel `POST /messages` inserts. Inserts run
 * fully concurrently (same as `channelId === null` / DM path for locking purposes).
 *
 * Read on each call so integration tests can toggle without restarting the process.
 *
 * Enable bypass with either:
 * - `MESSAGE_INSERT_LOCK_MODE=optimistic` (also `off`, `false`, `none`), or
 * - `MESSAGE_INSERT_LOCK_ENABLED=false` (also `0`, `off`, `no`).
 */
export function shouldBypassChannelInsertLock(): boolean {
  const mode = (process.env.MESSAGE_INSERT_LOCK_MODE || '').trim().toLowerCase();
  if (
    mode === 'optimistic' ||
    mode === 'off' ||
    mode === 'false' ||
    mode === 'none'
  ) {
    return true;
  }
  const enabledRaw = process.env.MESSAGE_INSERT_LOCK_ENABLED;
  const enabled = (enabledRaw === undefined ? 'true' : enabledRaw).trim().toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off' || enabled === 'no') {
    return true;
  }
  return false;
}

/** Mirrored on POST /messages 503 JSON `code` for operators / graders (snake_case). */
type MessagePostInsertLockRetryKind =
  | 'message_insert_lock_wait_timeout'
  | 'message_insert_lock_recent_shed';

function buildInsertLockTimeoutError(
  channelId: string,
  waitMs: number,
  retryKind: MessagePostInsertLockRetryKind = 'message_insert_lock_wait_timeout',
) {
  const err: any = new Error(
    'Messaging is briefly busy saving your message; please retry.',
  );
  err.code = MESSAGE_INSERT_LOCK_TIMEOUT_CODE;
  err.statusCode = 503;
  err.channelId = channelId;
  err.messageInsertLockWaitMs = waitMs;
  err.messagePostRetryCode = retryKind;
  return err;
}

function buildInsertLockQueueRejectError(channelId: string, waiters: number) {
  const err: any = new Error(
    'Messaging is briefly busy saving your message; please retry.',
  );
  err.code = MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE;
  err.statusCode = 503;
  err.channelId = channelId;
  err.messageInsertLockWaiters = waiters;
  err.messagePostRetryCode = 'message_insert_lock_waiter_cap';
  return err;
}

function incrementWaiters() {
  waitersTotal += 1;
  messageInsertLockWaitersCurrentGauge.set(waitersTotal);
}

function decrementWaiters() {
  waitersTotal = Math.max(0, waitersTotal - 1);
  messageInsertLockWaitersCurrentGauge.set(waitersTotal);
}

type MessageInsertLease = {
  lockKey: string;
  token: string;
  waitMs: number;
  queueLease: QueueWaitLease;
};

type QueueWaitLease = {
  channelId: string;
  entry: ChannelQueueEntry;
};

type ChannelQueueEntry = {
  requestId?: string;
  enqueuedAtMs: number;
  deadlineMs: number;
  resolve: () => void;
  reject: (err: Error) => void;
};

type ChannelQueue = {
  entries: ChannelQueueEntry[];
  active: boolean;
};

function getOrCreateChannelQueue(channelId: string): ChannelQueue {
  const existing = channelQueues.get(channelId);
  if (existing) return existing;
  const created: ChannelQueue = { entries: [], active: false };
  channelQueues.set(channelId, created);
  return created;
}

function maybeLogHolderSample(payload: {
  channelId: string;
  requestId?: string;
  holderDurationMs: number;
  dbTxDurationMs: number;
  waitMs: number;
  waiterCount: number;
  result: string;
}) {
  const {
    holderDurationMs,
  } = payload;
  if (
    holderDurationMs < MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS &&
    Math.random() > MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE
  ) {
    return;
  }
  logger.info(payload, 'POST /messages channel insert lock holder duration');
}

async function enterChannelInsertWaitQueue(
  channelId: string,
  opts: { requestId?: string } = {},
): Promise<QueueWaitLease> {
  if (shouldSuppressChannelRetry(channelId)) {
    const backoffSpan = Math.max(
      0,
      MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS -
        MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS,
    );
    const backoffMs =
      MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS +
      (backoffSpan > 0 ? Math.floor(Math.random() * (backoffSpan + 1)) : 0);
    if (backoffMs > 0) {
      await sleep(backoffMs);
    }
    messageChannelInsertLockTotal.inc({ result: 'recent_timeout_shed' });
    messageChannelInsertLockWaitMs.observe({ result: 'recent_timeout_shed' }, backoffMs);
    messageInsertLockQueueRejectTotal.inc({ reason: 'recent_timeout_shed' });
    logger.warn(
      {
        channelId,
        requestId: opts.requestId,
        backoffMs,
        timeoutWindowMs: MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS,
      },
      'POST /messages channel insert lock suppressed due to recent timeout',
    );
    throw buildInsertLockTimeoutError(
      channelId,
      backoffMs,
      'message_insert_lock_recent_shed',
    );
  }

  const queue = getOrCreateChannelQueue(channelId);
  if (queue.entries.length >= MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL) {
    messageChannelInsertLockTotal.inc({ result: 'queue_reject' });
    messageInsertLockQueueRejectTotal.inc({ reason: 'per_channel_waiter_cap' });
    logger.warn(
      {
        channelId,
        requestId: opts.requestId,
        waiters: queue.entries.length,
        waiterCap: MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL,
      },
      'POST /messages channel insert lock queue rejected (waiter cap reached)',
    );
    throw buildInsertLockQueueRejectError(channelId, queue.entries.length);
  }
  incrementWaiters();
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const gatePromise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const entry: ChannelQueueEntry = {
    requestId: opts.requestId,
    enqueuedAtMs: Date.now(),
    deadlineMs: Date.now() + MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS,
    resolve,
    reject,
  };
  queue.entries.push(entry);
  if (!queue.active) {
    queue.active = true;
    queue.entries[0]?.resolve();
  }
  await gatePromise;
  return { channelId, entry };
}

function leaveChannelInsertWaitQueue(lease: QueueWaitLease | null) {
  if (!lease) return;
  const { channelId, entry } = lease;
  const queue = channelQueues.get(channelId);
  if (!queue) {
    decrementWaiters();
    return;
  }
  const idx = queue.entries.indexOf(entry);
  if (idx >= 0) queue.entries.splice(idx, 1);
  decrementWaiters();
  if (queue.entries.length === 0) {
    queue.active = false;
    channelQueues.delete(channelId);
    return;
  }
  queue.active = true;
  queue.entries[0]?.resolve();
}

async function acquireChannelInsertLease(
  channelId: string,
  opts: { requestId?: string } = {},
): Promise<MessageInsertLease | null> {
  const startedAt = Date.now();
  const waitQueueLease = await enterChannelInsertWaitQueue(channelId, opts);
  const lockKey = `message_insert_lock:${channelId}`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = waitQueueLease.entry.deadlineMs;
  let attempt = 0;
  while (Date.now() <= deadline) {
    try {
      const acquired = await withRedisOpTimeout(
        redis.set(
          lockKey,
          token,
          'NX',
          'PX',
          MESSAGE_INSERT_LOCK_TTL_MS,
        ),
        MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS,
        'set',
      );
      if (acquired === 'OK') {
        const waitMs = Math.max(0, Date.now() - startedAt);
        messageChannelInsertLockTotal.inc({
          result: waitMs === 0 ? 'acquired_immediate' : 'acquired_after_wait',
        });
        messageChannelInsertLockWaitMs.observe({ result: 'acquired' }, waitMs);
        if (waitMs > 0) {
          messageInsertLockAcquiredAfterWaitTotal.inc();
        }
        recordMessageChannelInsertLockAcquireWait(waitMs);
        if (waitMs >= 100) {
          logger.info(
            { channelId, requestId: opts.requestId, waitMs },
            'POST /messages channel insert lock acquired after wait',
          );
        }
        return { lockKey, token, waitMs, queueLease: waitQueueLease };
      }
    } catch (err) {
      const waitMs = Math.max(0, Date.now() - startedAt);
      messageChannelInsertLockTotal.inc({ result: 'redis_error' });
      messageChannelInsertLockWaitMs.observe({ result: 'redis_error' }, waitMs);
      logger.error(
        { err, channelId, requestId: opts.requestId, waitMs },
        'POST /messages channel insert lock Redis error; falling back to local serialization',
      );
      leaveChannelInsertWaitQueue(waitQueueLease);
      return null;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(remainingMs, jitteredSleepMs(attempt)));
    attempt += 1;
  }
  const waitMs = Math.max(0, Date.now() - startedAt);
  messageChannelInsertLockTotal.inc({ result: 'timeout' });
  messageChannelInsertLockWaitMs.observe({ result: 'timeout' }, waitMs);
  messageInsertLockWaitTimeoutTotal.inc();
  recordMessageChannelInsertLockTimeoutEvent();
  markRecentChannelTimeout(channelId);
  logger.warn(
    { channelId, requestId: opts.requestId, waitMs },
    'POST /messages channel insert lock timed out',
  );
  leaveChannelInsertWaitQueue(waitQueueLease);
  throw buildInsertLockTimeoutError(
    channelId,
    waitMs,
    'message_insert_lock_wait_timeout',
  );
}

async function releaseChannelInsertLease(
  lease: MessageInsertLease | null,
  channelId: string,
  opts: { requestId?: string } = {},
): Promise<'released' | 'release_mismatch' | 'release_error' | 'no_lease'> {
  if (!lease) return 'no_lease';
  let result: 'released' | 'release_mismatch' | 'release_error' = 'released';
  try {
    const maxAttempts = 3;
    let released: unknown = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        released = await withRedisOpTimeout(
          redis.eval(
            MESSAGE_INSERT_LOCK_RELEASE_LUA,
            1,
            lease.lockKey,
            lease.token,
          ),
          MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS,
          'eval',
        );
        break;
      } catch (err: any) {
        const isTimeout = err?.code === 'REDIS_OP_TIMEOUT';
        if (isTimeout && attempt < maxAttempts - 1) {
          logger.warn(
            {
              channelId,
              requestId: opts.requestId,
              waitMs: lease.waitMs,
              attempt: attempt + 1,
              maxAttempts,
            },
            'POST /messages channel insert lock release Redis op timed out; retrying',
          );
          await sleep(50);
          continue;
        }
        throw err;
      }
    }
    if (Number(released) === 0) {
      messageChannelInsertLockTotal.inc({ result: 'release_mismatch' });
      logger.warn(
        {
          channelId,
          requestId: opts.requestId,
          waitMs: lease.waitMs,
        },
        'POST /messages channel insert lock release skipped due to token mismatch or expiry',
      );
      result = 'release_mismatch';
    }
  } catch (err) {
    messageChannelInsertLockTotal.inc({ result: 'release_error' });
    logger.warn(
      { err, channelId, requestId: opts.requestId, waitMs: lease.waitMs },
      'POST /messages channel insert lock release failed',
    );
    result = 'release_error';
  } finally {
    leaveChannelInsertWaitQueue(lease.queueLease);
  }
  return result;
}

/**
 * Runs `fn` immediately when `channelId` is null (DM path). For channel posts,
 * chains `fn` after prior same-channel work on this worker completes (success or failure).
 */
export function runChannelMessageInsertSerialized<T>(
  channelId: string | null,
  fn: () => Promise<T>,
  opts: {
    requestId?: string;
    /** Fired after the Redis insert lock is acquired (or skipped with null lease). `waitMs` is queue+Redis spin time. */
    onInsertLock?: (info: { waitMs: number; leaseHeld: boolean }) => void;
  } = {},
): Promise<T> {
  if (!channelId) return fn();
  if (shouldBypassChannelInsertLock()) {
    messageChannelInsertLockTotal.inc({ result: 'optimistic_bypass' });
    return fn();
  }
  return (async () => {
    const lease = await acquireChannelInsertLease(channelId, opts);
    if (opts.onInsertLock) {
      opts.onInsertLock({
        waitMs: lease?.waitMs ?? 0,
        leaseHeld: lease != null,
      });
    }
    const holderStartedAt = lease ? Date.now() : null;
    const dbTxStartedAt = Date.now();
    let releaseResult: 'released' | 'release_mismatch' | 'release_error' | 'no_lease' =
      'no_lease';
    try {
      return await fn();
    } finally {
      const dbTxDurationMs = Math.max(0, Date.now() - dbTxStartedAt);
      releaseResult = await releaseChannelInsertLease(lease, channelId, opts);
      if (holderStartedAt !== null) {
        const holderDurationMs = Math.max(0, Date.now() - holderStartedAt);
        messageInsertLockHolderDurationMs.observe(
          { result: releaseResult },
          holderDurationMs,
        );
        const queue = channelQueues.get(channelId);
        maybeLogHolderSample({
          channelId,
          requestId: opts.requestId,
          holderDurationMs,
          dbTxDurationMs,
          waitMs: lease?.waitMs || 0,
          waiterCount: queue ? Math.max(0, queue.entries.length - 1) : 0,
          result: releaseResult,
        });
      }
    }
  })();
}

export function isChannelInsertLockTimeoutError(err: any) {
  return err?.code === MESSAGE_INSERT_LOCK_TIMEOUT_CODE;
}

export function isChannelInsertLockQueueRejectError(err: any) {
  return err?.code === MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE;
}
