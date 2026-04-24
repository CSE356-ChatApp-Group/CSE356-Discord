'use strict';

/**
 * Option C — read_states Redis batch flush.
 *
 * Hot path: enqueueBatchReadStateUpdate() writes to Redis (loopback, sub-ms).
 * Background: flushDirtyReadStatesToDB() fires every READ_STATE_FLUSH_INTERVAL_MS
 * and upserts all dirty entries in a single UNNEST batch query, eliminating
 * per-row lock contention on read_states that caused max_exec_time=6506ms.
 *
 * Redis keys:
 *   rs:dirty               — SET of "userId|targetId" composite keys (targetId = channelId ?? conversationId)
 *   rs:pending:{userId}:{targetId} — HASH with: msg_id, msg_created_at, channel_id, conversation_id
 */

const { query } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');

const RS_DIRTY_SET = 'rs:dirty';
const RS_PENDING_KEY_PREFIX = 'rs:pending:';
const RS_FLUSH_LOCK_KEY = 'rs:flush:lock';

const READ_STATE_FLUSH_INTERVAL_MS = parseInt(
  process.env.READ_STATE_FLUSH_INTERVAL_MS || '10000', 10,
);
const READ_STATE_FLUSH_BATCH_SIZE = Math.min(
  200,
  Math.max(25, parseInt(process.env.READ_STATE_FLUSH_BATCH_SIZE || '100', 10) || 100),
);
const READ_STATE_FLUSH_LOCK_TTL_MS = Math.min(
  60000,
  Math.max(
    READ_STATE_FLUSH_INTERVAL_MS,
    parseInt(process.env.READ_STATE_FLUSH_LOCK_TTL_MS || '30000', 10) || 30000,
  ),
);
const READ_STATE_FLUSH_RETRY_MAX = Math.min(
  3,
  Math.max(0, parseInt(process.env.READ_STATE_FLUSH_RETRY_MAX || '2', 10) || 2),
);

let localFlushInFlight = false;

const READ_STATE_BATCH_UPSERT_SQL = `
  INSERT INTO read_states (
    user_id,
    channel_id,
    conversation_id,
    last_read_message_id,
    last_read_message_created_at,
    last_read_at
  )
  SELECT v.user_id, v.channel_id, v.conversation_id, v.msg_id, v.msg_created_at, NOW()
  FROM (
    SELECT
      UNNEST($1::uuid[])        AS user_id,
      UNNEST($2::uuid[])        AS channel_id,
      UNNEST($3::uuid[])        AS conversation_id,
      UNNEST($4::uuid[])        AS msg_id,
      UNNEST($5::timestamptz[]) AS msg_created_at
  ) v
  JOIN messages ON messages.id = v.msg_id
  ORDER BY v.user_id, COALESCE(v.channel_id, v.conversation_id)
  ON CONFLICT (user_id, COALESCE(channel_id, conversation_id)) DO UPDATE SET
    last_read_message_id = EXCLUDED.last_read_message_id,
    last_read_message_created_at = EXCLUDED.last_read_message_created_at,
    last_read_at = NOW()
  WHERE
    read_states.last_read_message_created_at IS NULL
    OR EXCLUDED.last_read_message_created_at >= read_states.last_read_message_created_at
`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushRetryDelayMs(attempt: number) {
  const base = 40 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 25);
  return Math.min(250, base + jitter);
}

function isRetryableFlushError(err: any) {
  const code = String(err?.code || '');
  const message = String(err?.message || '').toLowerCase();
  return (
    code === '40P01' ||
    code === '57014' ||
    message.includes('deadlock detected') ||
    message.includes('statement timeout')
  );
}

async function acquireFlushLock(): Promise<string | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  try {
    const acquired = await redis.set(
      RS_FLUSH_LOCK_KEY,
      token,
      'PX',
      READ_STATE_FLUSH_LOCK_TTL_MS,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  } catch {
    return null;
  }
}

async function releaseFlushLock(token: string): Promise<void> {
  try {
    await redis.eval(
      `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `,
      1,
      RS_FLUSH_LOCK_KEY,
      token,
    );
  } catch {
    // ignore
  }
}

async function runReadStateBatchUpsert(params: [
  string[],
  (string | null)[],
  (string | null)[],
  string[],
  string[],
]) {
  for (let attempt = 0; attempt <= READ_STATE_FLUSH_RETRY_MAX; attempt += 1) {
    try {
      await query(READ_STATE_BATCH_UPSERT_SQL, params);
      return;
    } catch (err: any) {
      if (attempt >= READ_STATE_FLUSH_RETRY_MAX || !isRetryableFlushError(err)) {
        throw err;
      }
      logger.warn(
        { err, attempt: attempt + 1, retryMax: READ_STATE_FLUSH_RETRY_MAX },
        'read_state batch flush retryable query failure',
      );
      await sleep(flushRetryDelayMs(attempt + 1));
    }
  }
}

/**
 * Enqueue a read_state update to Redis. Returns immediately (sub-ms).
 * The background flush interval will upsert to DB within READ_STATE_FLUSH_INTERVAL_MS.
 */
async function enqueueBatchReadStateUpdate(
  userId: string,
  channelId: string | null | undefined,
  conversationId: string | null | undefined,
  messageId: string,
  messageCreatedAt: string | Date,
): Promise<void> {
  const targetId = channelId ?? conversationId;
  if (!targetId) return;

  const dirtyKey = `${userId}|${targetId}`;
  const pendingKey = `${RS_PENDING_KEY_PREFIX}${userId}:${targetId}`;

  const createdAtStr = typeof messageCreatedAt === 'string'
    ? messageCreatedAt
    : (messageCreatedAt as Date).toISOString();

  try {
    // MULTI keeps HSET + EXPIRE atomic so a key cannot exist without TTL if the transaction commits.
    await redis
      .multi()
      .hset(
        pendingKey,
        'msg_id', messageId,
        'msg_created_at', createdAtStr,
        'channel_id', channelId ?? '',
        'conversation_id', conversationId ?? '',
      )
      .expire(pendingKey, 86400) // 24h TTL — prevents unbounded memory from inactive (user, target) pairs
      .sadd(RS_DIRTY_SET, dirtyKey)
      .exec();
  } catch (err: any) {
    logger.warn({ err, userId, channelId, conversationId, messageId }, 'batchReadState Redis enqueue failed');
  }
}

/**
 * Background flush: reads all dirty entries from Redis and upserts to DB in one query.
 */
async function flushDirtyReadStatesToDB(): Promise<void> {
  if (localFlushInFlight) return;
  localFlushInFlight = true;

  let flushLockToken: string | null = null;
  let dirtyKeys: string[];
  try {
    flushLockToken = await acquireFlushLock();
    if (!flushLockToken) return;

    try {
      dirtyKeys = await redis.smembers(RS_DIRTY_SET);
    } catch {
      return;
    }

    if (dirtyKeys.length === 0) return;

    dirtyKeys.sort();

    // Do NOT srem from rs:dirty before reading rs:pending:* — if hgetall is empty or the
    // upsert is skipped, we would drop the dirty flag without persisting (flaky tests +
    // lost read cursors). Remove keys only after a successful batch upsert, or when a
    // dirty entry has no pending payload (stale pointer — clear to avoid spinning).

    for (let i = 0; i < dirtyKeys.length; i += READ_STATE_FLUSH_BATCH_SIZE) {
      const batch = dirtyKeys.slice(i, i + READ_STATE_FLUSH_BATCH_SIZE);

      const pipeline = redis.pipeline();
      for (const dirtyKey of batch) {
        const [userId, targetId] = dirtyKey.split('|');
        pipeline.hgetall(`${RS_PENDING_KEY_PREFIX}${userId}:${targetId}`);
      }

      let results: [Error | null, Record<string, string> | null][];
      try {
        results = await pipeline.exec();
      } catch {
        continue;
      }

      const dirtyKeysStale: string[] = [];
      const newestRowsByDirtyKey = new Map<string, {
        dirtyKey: string;
        userId: string;
        channelId: string | null;
        conversationId: string | null;
        messageId: string;
        messageCreatedAt: string;
      }>();

      for (let j = 0; j < batch.length; j++) {
        const dirtyKey = batch[j];
        const [pipeErr, data] = results[j];
        if (pipeErr || !data || !data.msg_id || !data.msg_created_at) {
          dirtyKeysStale.push(dirtyKey);
          continue;
        }

        const [userId] = dirtyKey.split('|');
        const nextRow = {
          dirtyKey,
          userId,
          channelId: data.channel_id || null,
          conversationId: data.conversation_id || null,
          messageId: data.msg_id,
          messageCreatedAt: data.msg_created_at,
        };
        const prevRow = newestRowsByDirtyKey.get(dirtyKey);
        if (!prevRow || nextRow.messageCreatedAt >= prevRow.messageCreatedAt) {
          newestRowsByDirtyKey.set(dirtyKey, nextRow);
        }
      }

      const orderedRows = Array.from(newestRowsByDirtyKey.values()).sort((a, b) => {
        const aTarget = a.channelId || a.conversationId || '';
        const bTarget = b.channelId || b.conversationId || '';
        return a.userId.localeCompare(b.userId) || aTarget.localeCompare(bTarget);
      });

      if (orderedRows.length > 0) {
        try {
          await runReadStateBatchUpsert([
            orderedRows.map((row) => row.userId),
            orderedRows.map((row) => row.channelId),
            orderedRows.map((row) => row.conversationId),
            orderedRows.map((row) => row.messageId),
            orderedRows.map((row) => row.messageCreatedAt),
          ]);
        } catch (err: any) {
          logger.warn({ err, batchSize: orderedRows.length }, 'read_state batch flush query failed');
          continue;
        }
      }

      const toClear = [
        ...orderedRows.map((row) => row.dirtyKey),
        ...dirtyKeysStale,
      ];
      if (toClear.length === 0) continue;

      try {
        if (toClear.length === 1) {
          await redis.srem(RS_DIRTY_SET, toClear[0]);
        } else {
          await redis.srem(RS_DIRTY_SET, ...toClear);
        }
      } catch {
        // ignore
      }
    }
  } finally {
    if (flushLockToken) {
      await releaseFlushLock(flushLockToken);
    }
    localFlushInFlight = false;
  }
}

function startReadStateFlushInterval(intervalMs: number = READ_STATE_FLUSH_INTERVAL_MS): void {
  setInterval(flushDirtyReadStatesToDB, intervalMs).unref();
}

module.exports = {
  enqueueBatchReadStateUpdate,
  flushDirtyReadStatesToDB,
  startReadStateFlushInterval,
};
