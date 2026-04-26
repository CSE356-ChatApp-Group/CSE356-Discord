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
} = require('../utils/metrics');
const {
  recordMessageChannelInsertLockAcquireWait,
  recordMessageChannelInsertLockTimeoutEvent,
} = require('./messageInsertLockPressure');

const tail = new Map<string, Promise<unknown>>();

const MESSAGE_INSERT_LOCK_TTL_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_TTL_MS',
  45000,
  5000,
  120000,
);
const MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS',
  4000,
  500,
  15000,
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
const MESSAGE_INSERT_LOCK_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;
const MESSAGE_INSERT_LOCK_TIMEOUT_CODE = 'MESSAGE_INSERT_LOCK_TIMEOUT';
const MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE = 'MESSAGE_INSERT_LOCK_QUEUE_REJECT';
const channelWaiters = new Map<string, number>();
let waitersTotal = 0;
const MESSAGE_INSERT_LOCK_WAITERS_KEY_TTL_MS = Math.min(
  180000,
  MESSAGE_INSERT_LOCK_TTL_MS + MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS + 1000,
);

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredSleepMs(attempt: number) {
  const base = Math.min(
    MESSAGE_INSERT_LOCK_POLL_MAX_MS,
    MESSAGE_INSERT_LOCK_POLL_MIN_MS * Math.pow(2, Math.max(0, attempt)),
  );
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
  return Math.min(MESSAGE_INSERT_LOCK_POLL_MAX_MS, base + jitter);
}

function buildInsertLockTimeoutError(channelId: string, waitMs: number) {
  const err: any = new Error(
    'Messaging is briefly busy saving your message; please retry.',
  );
  err.code = MESSAGE_INSERT_LOCK_TIMEOUT_CODE;
  err.statusCode = 503;
  err.channelId = channelId;
  err.messageInsertLockWaitMs = waitMs;
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
  return err;
}

function incrementWaiters(channelId: string) {
  const next = (channelWaiters.get(channelId) || 0) + 1;
  channelWaiters.set(channelId, next);
  waitersTotal += 1;
  messageInsertLockWaitersCurrentGauge.set(waitersTotal);
  return next;
}

function decrementWaiters(channelId: string) {
  const current = channelWaiters.get(channelId) || 0;
  if (current <= 1) channelWaiters.delete(channelId);
  else channelWaiters.set(channelId, current - 1);
  waitersTotal = Math.max(0, waitersTotal - 1);
  messageInsertLockWaitersCurrentGauge.set(waitersTotal);
}

type MessageInsertLease = {
  lockKey: string;
  token: string;
  waitMs: number;
};

type MessageInsertWaitQueueLease = {
  waitersKey: string;
  tracked: boolean;
};

async function enterChannelInsertWaitQueue(
  channelId: string,
  opts: { requestId?: string } = {},
): Promise<MessageInsertWaitQueueLease> {
  const waitersKey = `message_insert_lock_waiters:${channelId}`;
  try {
    const waiterCount = Number(await redis.incr(waitersKey));
    await redis.pexpire(waitersKey, MESSAGE_INSERT_LOCK_WAITERS_KEY_TTL_MS);
    if (waiterCount > MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL) {
      await redis.decr(waitersKey);
      messageChannelInsertLockTotal.inc({ result: 'queue_reject' });
      messageInsertLockQueueRejectTotal.inc({ reason: 'per_channel_waiter_cap' });
      logger.warn(
        {
          channelId,
          requestId: opts.requestId,
          waiters: waiterCount,
          waiterCap: MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL,
        },
        'POST /messages channel insert lock queue rejected (waiter cap reached)',
      );
      throw buildInsertLockQueueRejectError(channelId, waiterCount);
    }
    return { waitersKey, tracked: true };
  } catch (err: any) {
    if (err?.code === MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE) throw err;
    logger.warn(
      { err, channelId, requestId: opts.requestId },
      'POST /messages channel insert lock waiter admission check failed; continuing without cap enforcement',
    );
    return { waitersKey, tracked: false };
  }
}

async function leaveChannelInsertWaitQueue(lease: MessageInsertWaitQueueLease) {
  if (!lease.tracked) return;
  try {
    await redis.decr(lease.waitersKey);
  } catch {
    // best effort cleanup; key TTL handles stale counters
  }
}

async function acquireChannelInsertLease(
  channelId: string,
  opts: { requestId?: string } = {},
): Promise<MessageInsertLease | null> {
  const waitQueueLease = await enterChannelInsertWaitQueue(channelId, opts);
  incrementWaiters(channelId);
  const lockKey = `message_insert_lock:${channelId}`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const deadline = startedAt + MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS;
  let attempt = 0;
  try {
    while (Date.now() <= deadline) {
      try {
        const acquired = await redis.set(
          lockKey,
          token,
          'NX',
          'PX',
          MESSAGE_INSERT_LOCK_TTL_MS,
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
          return { lockKey, token, waitMs };
        }
      } catch (err) {
        const waitMs = Math.max(0, Date.now() - startedAt);
        messageChannelInsertLockTotal.inc({ result: 'redis_error' });
        messageChannelInsertLockWaitMs.observe({ result: 'redis_error' }, waitMs);
        logger.error(
          { err, channelId, requestId: opts.requestId, waitMs },
          'POST /messages channel insert lock Redis error; falling back to local serialization',
        );
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
    logger.warn(
      { channelId, requestId: opts.requestId, waitMs },
      'POST /messages channel insert lock timed out',
    );
    throw buildInsertLockTimeoutError(channelId, waitMs);
  } finally {
    decrementWaiters(channelId);
    await leaveChannelInsertWaitQueue(waitQueueLease);
  }
}

async function releaseChannelInsertLease(
  lease: MessageInsertLease | null,
  channelId: string,
  opts: { requestId?: string } = {},
) {
  if (!lease) return;
  try {
    const released = await redis.eval(
      MESSAGE_INSERT_LOCK_RELEASE_LUA,
      1,
      lease.lockKey,
      lease.token,
    );
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
    }
  } catch (err) {
    messageChannelInsertLockTotal.inc({ result: 'release_error' });
    logger.warn(
      { err, channelId, requestId: opts.requestId, waitMs: lease.waitMs },
      'POST /messages channel insert lock release failed',
    );
  }
}

/**
 * Runs `fn` immediately when `channelId` is null (DM path). For channel posts,
 * chains `fn` after prior same-channel work on this worker completes (success or failure).
 */
export function runChannelMessageInsertSerialized<T>(
  channelId: string | null,
  fn: () => Promise<T>,
  opts: { requestId?: string } = {},
): Promise<T> {
  if (!channelId) return fn();

  const prev = tail.get(channelId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const lease = await acquireChannelInsertLease(channelId, opts);
      try {
        return await fn();
      } finally {
        await releaseChannelInsertLease(lease, channelId, opts);
      }
    }) as Promise<T>;
  tail.set(channelId, next);
  return next.finally(() => {
    if (tail.get(channelId) === next) tail.delete(channelId);
  });
}

export function isChannelInsertLockTimeoutError(err: any) {
  return err?.code === MESSAGE_INSERT_LOCK_TIMEOUT_CODE;
}

export function isChannelInsertLockQueueRejectError(err: any) {
  return err?.code === MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE;
}
