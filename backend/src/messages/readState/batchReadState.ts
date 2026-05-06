
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

const redis = require('../../db/redis');
const { redisBatchSrem } = require('../../db/redisBatch');
const logger = require('../../utils/logger');
const {
  readStateDirtyKeysGauge,
  readStateFlushRows,
  readStateFlushDurationMs,
  readStateFlushErrorsTotal,
  readStateFlushDeferredTotal,
  readStateFlushDeferredDirtyKeys,
} = require('../../utils/metrics');
const { getShouldDeferReadReceiptForMessageInsertUnhealthy } = require('../messageInsertHealth');
const { batchReadStateConfig } = require('../config/batchReadStateConfig');
const {
  acquireFlushLock,
  releaseFlushLock,
  runReadStateBatchUpsert,
  readDirtyKeysBatch,
} = require('./batchReadStateFlushHelpers');
const {
  RS_DIRTY_SET,
  RS_PENDING_KEY_PREFIX,
  RS_FLUSH_LOCK_KEY,
  RS_PENDING_TTL_SECS,
  READ_STATE_FLUSH_INTERVAL_MS,
  READ_STATE_FLUSH_BATCH_SIZE,
  READ_STATE_FLUSH_SCAN_COUNT,
  READ_STATE_FLUSH_LOCK_TTL_MS,
  READ_STATE_FLUSH_RETRY_MAX,
} = batchReadStateConfig;

const READ_STATE_FLUSH_DEFER_ON_DB_PRESSURE_ENABLED =
  process.env.READ_STATE_FLUSH_DEFER_ON_DB_PRESSURE_ENABLED !== 'false';
const READ_STATE_FLUSH_PRESSURE_MAX_DEFER_MS = Number(
  process.env.READ_STATE_FLUSH_PRESSURE_MAX_DEFER_MS || '60000',
);
const READ_STATE_FLUSH_PRESSURE_TIMEOUT_WINDOW_MS = Number(
  process.env.READ_STATE_FLUSH_PRESSURE_TIMEOUT_WINDOW_MS || '10000',
);
const READ_STATE_FLUSH_PRESSURE_TIMEOUT_THRESHOLD = Number(
  process.env.READ_STATE_FLUSH_PRESSURE_TIMEOUT_THRESHOLD || '2',
);

let flushPressureUntilMs = 0;
let flushPressureFirstDeferMs = 0;
const recentFlushTimeouts: number[] = [];

function isReadStateFlushUnderDbPressure(): boolean {
  if (!READ_STATE_FLUSH_DEFER_ON_DB_PRESSURE_ENABLED) return false;
  const now = Date.now();
  if (now < flushPressureUntilMs) return true;
  const cutoff = now - READ_STATE_FLUSH_PRESSURE_TIMEOUT_WINDOW_MS;
  while (recentFlushTimeouts.length > 0 && recentFlushTimeouts[0] < cutoff) {
    recentFlushTimeouts.shift();
  }
  return recentFlushTimeouts.length >= READ_STATE_FLUSH_PRESSURE_TIMEOUT_THRESHOLD;
}

function recordReadStateFlushUpsertTimeout(): void {
  recentFlushTimeouts.push(Date.now());
}

function resetReadStateFlushPressureForTests(): void {
  flushPressureUntilMs = 0;
  flushPressureFirstDeferMs = 0;
  recentFlushTimeouts.length = 0;
}

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

  // Scope prefix co-locates the dirty key with the pending key's hash tag and
  // the read_cursor_ts / read_db_lock keys used in the Lua CAS script.
  const scope = channelId ? `ch:${channelId}` : `cv:${conversationId}`;
  const dirtyKey = `${userId}|${scope}`;
  // Hash tag {userId:scope} places cursor, lock, and pending on the same slot.
  const pendingKey = `${RS_PENDING_KEY_PREFIX}{${userId}:${scope}}`;

  const createdAtStr = typeof messageCreatedAt === 'string'
    ? messageCreatedAt
    : (messageCreatedAt as Date).toISOString();

  try {
    // MULTI keeps HSET + EXPIRE atomic so a key cannot exist without TTL.
    // RS_DIRTY_SET (global key) is added separately so it can live on a
    // different cluster slot than the per-user-pair pending key.
    await redis
      .multi()
      .hset(
        pendingKey,
        'msg_id', messageId,
        'msg_created_at', createdAtStr,
        'channel_id', channelId ?? '',
        'conversation_id', conversationId ?? '',
      )
      .expire(pendingKey, RS_PENDING_TTL_SECS)
      .exec();
    await redis.sadd(RS_DIRTY_SET, dirtyKey);
  } catch (err: any) {
    logger.warn({ err, userId, channelId, conversationId, messageId }, 'batchReadState Redis enqueue failed');
  }
}

function batchReadStateRedisKeys(
  userId: string,
  channelId: string | null | undefined,
  conversationId: string | null | undefined,
) {
  const targetId = channelId ?? conversationId;
  if (!targetId) return null;
  const scope = channelId ? `ch:${channelId}` : `cv:${conversationId}`;
  return {
    dirtySetKey: RS_DIRTY_SET,
    dirtyKey: `${userId}|${scope}`,
    pendingKey: `${RS_PENDING_KEY_PREFIX}{${userId}:${scope}}`,
    pendingTtlSeconds: RS_PENDING_TTL_SECS,
  };
}

/**
 * Background flush: reads all dirty entries from Redis and upserts to DB in one query.
 */
async function flushDirtyReadStatesToDB(): Promise<void> {
  const insertUnhealthy = READ_STATE_FLUSH_DEFER_ON_DB_PRESSURE_ENABLED
    && getShouldDeferReadReceiptForMessageInsertUnhealthy();
  const flushPressure = isReadStateFlushUnderDbPressure();

  if (insertUnhealthy || flushPressure) {
    const now = Date.now();
    const reason = insertUnhealthy ? 'insert_unhealthy' : 'flush_pressure';

    if (flushPressureFirstDeferMs === 0) {
      flushPressureFirstDeferMs = now;
    }

    if (now - flushPressureFirstDeferMs < READ_STATE_FLUSH_PRESSURE_MAX_DEFER_MS) {
      readStateFlushDeferredTotal.inc({ reason });
      try {
        const sc = await redis.scard(RS_DIRTY_SET);
        readStateFlushDeferredDirtyKeys.set(Number.isFinite(Number(sc)) ? Number(sc) : 0);
      } catch {
        // ignore
      }
      return;
    }

    // Max deferral exceeded — fall through and flush regardless of pressure
    flushPressureFirstDeferMs = 0;
    flushPressureUntilMs = 0;
    recentFlushTimeouts.length = 0;
    logger.warn({ reason }, 'read_state flush max-deferral guard triggered — forcing flush');
  } else {
    flushPressureFirstDeferMs = 0;
  }

  if (localFlushInFlight) return;
  localFlushInFlight = true;

  let flushLockToken: string | null = null;
  try {
    flushLockToken = await acquireFlushLock();
    if (!flushLockToken) return;

    const lockedStart = process.hrtime.bigint();
    try {
      try {
        const sc = await redis.scard(RS_DIRTY_SET);
        readStateDirtyKeysGauge.set(Number.isFinite(Number(sc)) ? Number(sc) : 0);
      } catch {
        readStateFlushErrorsTotal.inc({ stage: 'scard' });
      }

      let dirtyKeys: string[];
      try {
        dirtyKeys = await readDirtyKeysBatch();
      } catch {
        readStateFlushErrorsTotal.inc({ stage: 'dirty_keys' });
        return;
      }

      if (dirtyKeys.length === 0) return;

      // Do NOT srem from rs:dirty before reading rs:pending:* — if hgetall is empty or the
      // upsert is skipped, we would drop the dirty flag without persisting (flaky tests +
      // lost read cursors). Remove keys only after a successful batch upsert, or when a
      // dirty entry has no pending payload (stale pointer — clear to avoid spinning).

      for (let i = 0; i < dirtyKeys.length; i += READ_STATE_FLUSH_BATCH_SIZE) {
        const batch = dirtyKeys.slice(i, i + READ_STATE_FLUSH_BATCH_SIZE);

        const pipeline = redis.pipeline();
        for (const dirtyKey of batch) {
          // dirtyKey format: "userId|scope" where scope = "ch:channelId" or "cv:conversationId"
          const pipeIdx = dirtyKey.indexOf('|');
          const userId = pipeIdx > 0 ? dirtyKey.slice(0, pipeIdx) : dirtyKey;
          const scope  = pipeIdx > 0 ? dirtyKey.slice(pipeIdx + 1) : '';
          pipeline.hgetall(`${RS_PENDING_KEY_PREFIX}{${userId}:${scope}}`);
        }

        let results: [Error | null, Record<string, string> | null][];
        try {
          results = await pipeline.exec();
        } catch {
          readStateFlushErrorsTotal.inc({ stage: 'pending_pipeline' });
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
            await runReadStateBatchUpsert(
              READ_STATE_BATCH_UPSERT_SQL,
              [
              orderedRows.map((row) => row.userId),
              orderedRows.map((row) => row.channelId),
              orderedRows.map((row) => row.conversationId),
              orderedRows.map((row) => row.messageId),
              orderedRows.map((row) => row.messageCreatedAt),
              ],
            );
            readStateFlushRows.observe(orderedRows.length);
          } catch (err: any) {
            readStateFlushErrorsTotal.inc({ stage: 'upsert' });
            const code = String(err?.code || '');
            const msg = String(err?.message || '').toLowerCase();
            if (code === '57014' || msg.includes('statement timeout')) {
              recordReadStateFlushUpsertTimeout();
            }
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
          await redisBatchSrem(redis, RS_DIRTY_SET, toClear);
        } catch {
          readStateFlushErrorsTotal.inc({ stage: 'clear_dirty' });
        }
      }
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - lockedStart) / 1e6;
      readStateFlushDurationMs.observe(Math.max(0, elapsedMs));
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
  batchReadStateRedisKeys,
  flushDirtyReadStatesToDB,
  startReadStateFlushInterval,
  resetReadStateFlushPressureForTests,
};
