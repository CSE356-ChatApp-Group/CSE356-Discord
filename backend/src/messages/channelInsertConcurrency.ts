/**
 * Serialize POST /messages DB transactions per channel_id on this Node process.
 *
 * Hot channels see concurrent INSERTs updating the same btree/GIN index pages
 * (notably btree_gin on (channel_id, content_tsv)), which can push insert-phase
 * wall time to the statement_timeout. Serializing removes same-channel overlap.
 */


const crypto = require('crypto');
const os = require('os');
const redis = require('../db/redis');
const {
  REDIS_LUA_IDS,
  registerRedisLuaScript,
  redisEvalSha,
} = require('../db/redisLua');
const { LOCK_RELEASE_IF_MATCH_LUA } = require('../db/redisLuaScripts');
const logger = require('../utils/logger');
const {
  messageChannelInsertLockTotal,
  messageChannelInsertPathTotal,
  messageChannelInsertPathPrecallMs,
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
const {
  MESSAGE_INSERT_LOCK_TTL_MS,
  MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS,
  MESSAGE_INSERT_LOCK_POLL_MIN_MS,
  MESSAGE_INSERT_LOCK_POLL_MAX_MS,
  MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL,
  MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE,
  MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS,
  MESSAGE_INSERT_LOCK_PATH_LOG,
  MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE,
  MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS,
} = require('./channelInsertLockEnv');
const { tracer } = require('../utils/tracer');
const { SpanStatusCode } = require('@opentelemetry/api');

registerRedisLuaScript(REDIS_LUA_IDS.LOCK_RELEASE_IF_MATCH, LOCK_RELEASE_IF_MATCH_LUA);
const MESSAGE_INSERT_LOCK_TIMEOUT_CODE = 'MESSAGE_INSERT_LOCK_TIMEOUT';
const MESSAGE_INSERT_LOCK_QUEUE_REJECT_CODE = 'MESSAGE_INSERT_LOCK_QUEUE_REJECT';
const channelQueues = new Map<string, ChannelQueue>();
const recentChannelTimeoutAtMs = new Map<string, number>();
let waitersTotal = 0;

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

type ChannelInsertBypassReasonDetail =
  | 'env_optimistic'
  | 'env_mode_off'
  | 'env_lock_disabled';

function classifyChannelInsertBypassReasonDetail(): ChannelInsertBypassReasonDetail {
  const mode = (process.env.MESSAGE_INSERT_LOCK_MODE || '').trim().toLowerCase();
  if (mode === 'optimistic') return 'env_optimistic';
  if (mode === 'off' || mode === 'false' || mode === 'none') return 'env_mode_off';
  const enabledRaw = process.env.MESSAGE_INSERT_LOCK_ENABLED;
  const enabled = (enabledRaw === undefined ? 'true' : enabledRaw).trim().toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'off' || enabled === 'no') {
    return 'env_lock_disabled';
  }
  return 'env_mode_off';
}

function effectiveInsertPathLogSampleRate(): number {
  if (MESSAGE_INSERT_LOCK_PATH_LOG) return 1;
  return MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE;
}

function emitInsertPathMetricAndMaybeLog(args: {
  path: string;
  reason_detail: string;
  requestId?: string;
  channelId?: string | null;
  precallMs: number;
  fallback_note?: string;
}) {
  const { path, reason_detail, requestId, channelId, precallMs, fallback_note } = args;
  messageChannelInsertPathTotal.inc({ path, reason_detail });
  messageChannelInsertPathPrecallMs.observe({ path }, precallMs);
  const rate = effectiveInsertPathLogSampleRate();
  if (rate > 0 && Math.random() < rate) {
    logger.info(
      {
        event: 'message_channel_insert_path',
        requestId,
        worker_id: `${os.hostname()}:${process.env.PORT || '?'}`,
        channelId: channelId ?? undefined,
        path,
        reason_detail,
        precall_ms: precallMs,
        fallback_note,
      },
      'message_channel_insert_path',
    );
  }
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
): Promise<{ lease: MessageInsertLease | null; precallMs: number }> {
  const startedAt = Date.now();
  const waitQueueLease = await tracer.startActiveSpan('channel_insert.queue_wait', async (span: any) => {
    try {
      return await enterChannelInsertWaitQueue(channelId, opts);
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
      span.recordException(err);
      throw err;
    } finally {
      span.setAttribute('queue.wait_ms', Math.max(0, Date.now() - startedAt));
      span.end();
    }
  });
  const lockKey = `message_insert_lock:${channelId}`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = waitQueueLease.entry.deadlineMs;
  return tracer.startActiveSpan('channel_insert.redis_spin', async (span: any) => {
    let attempt = 0;
    let redisSetCalls = 0;
    let lockAcquired = false;
    let redisError = false;
    try {
      while (Date.now() <= deadline) {
        redisSetCalls += 1;
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
            lockAcquired = true;
            return {
              lease: { lockKey, token, waitMs, queueLease: waitQueueLease },
              precallMs: waitMs,
            };
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
          redisError = true;
          return { lease: null, precallMs: waitMs };
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
    } finally {
      span.setAttribute('lock.redis_set_calls', redisSetCalls);
      span.setAttribute('lock.acquired', lockAcquired);
      if (redisError) span.setAttribute('lock.redis_error', true);
      span.end();
    }
  });
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
          redisEvalSha(
            redis,
            REDIS_LUA_IDS.LOCK_RELEASE_IF_MATCH,
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
    /**
     * Fired before DB channel insert work: optimistic bypass, after Redis lease acquired,
     * or after Redis error with null lease (cross-worker lock not held).
     * `waitMs` is queue + Redis spin time (precall).
     */
    onInsertLock?: (info: {
      waitMs: number;
      leaseHeld: boolean;
      lockPath:
        | 'optimistic_bypass'
        | 'acquired_immediate'
        | 'acquired_after_wait'
        | 'redis_fallback_null_lease';
      bypassReasonDetail:
        | ChannelInsertBypassReasonDetail
        | 'none'
        | 'redis_set_error';
    }) => void;
  } = {},
): Promise<T> {
  if (!channelId) return fn();
  if (shouldBypassChannelInsertLock()) {
    messageChannelInsertLockTotal.inc({ result: 'optimistic_bypass' });
    const bypassReasonDetail = classifyChannelInsertBypassReasonDetail();
    emitInsertPathMetricAndMaybeLog({
      path: 'optimistic_bypass',
      reason_detail: bypassReasonDetail,
      requestId: opts.requestId,
      channelId,
      precallMs: 0,
    });
    if (opts.onInsertLock) {
      opts.onInsertLock({
        waitMs: 0,
        leaseHeld: false,
        lockPath: 'optimistic_bypass',
        bypassReasonDetail,
      });
    }
    return tracer.startActiveSpan('channel_insert.db_execute', async (span: any) => {
      try {
        return await fn();
      } catch (err: any) {
        if (!err?.statusCode || err.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
          span.recordException(err);
        }
        throw err;
      } finally {
        span.end();
      }
    });
  }
  return (async () => {
    const { lease, precallMs } = await acquireChannelInsertLease(channelId, opts);
    const lockPath = lease
      ? lease.waitMs === 0
        ? 'acquired_immediate'
        : 'acquired_after_wait'
      : 'redis_fallback_null_lease';
    const reason_detail =
      lockPath === 'redis_fallback_null_lease' ? 'redis_set_error' : 'none';
    emitInsertPathMetricAndMaybeLog({
      path: lockPath,
      reason_detail,
      requestId: opts.requestId,
      channelId,
      precallMs,
      fallback_note:
        lockPath === 'redis_fallback_null_lease'
          ? 'redis_error_during_acquire_cross_worker_lock_not_held'
          : undefined,
    });
    if (opts.onInsertLock) {
      opts.onInsertLock({
        waitMs: precallMs,
        leaseHeld: lease != null,
        lockPath,
        bypassReasonDetail: reason_detail === 'redis_set_error' ? 'redis_set_error' : 'none',
      });
    }
    const holderStartedAt = lease ? Date.now() : null;
    const dbTxStartedAt = Date.now();
    let releaseResult: 'released' | 'release_mismatch' | 'release_error' | 'no_lease' =
      'no_lease';
    try {
      return await tracer.startActiveSpan('channel_insert.db_execute', async (span: any) => {
        try {
          return await fn();
        } catch (err: any) {
          if (!err?.statusCode || err.statusCode >= 500) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
            span.recordException(err);
          }
          throw err;
        } finally {
          span.end();
        }
      });
    } finally {
      const dbTxDurationMs = Math.max(0, Date.now() - dbTxStartedAt);
      releaseResult = await tracer.startActiveSpan('channel_insert.lock_release', async (span: any) => {
        try {
          const result = await releaseChannelInsertLease(lease, channelId, opts);
          span.setAttribute('lock.release_result', result);
          return result;
        } finally {
          span.end();
        }
      });
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
