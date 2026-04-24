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

const READ_STATE_FLUSH_INTERVAL_MS = parseInt(
  process.env.READ_STATE_FLUSH_INTERVAL_MS || '10000', 10,
);
const READ_STATE_FLUSH_BATCH_SIZE = 200;

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
  let dirtyKeys: string[];
  try {
    dirtyKeys = await redis.smembers(RS_DIRTY_SET);
  } catch {
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
      const [userId, targetId] = dirtyKey.split('|');
      pipeline.hgetall(`${RS_PENDING_KEY_PREFIX}${userId}:${targetId}`);
    }

    let results: [Error | null, Record<string, string> | null][];
    try {
      results = await pipeline.exec();
    } catch {
      continue;
    }

    const userIds: string[] = [];
    const channelIds: (string | null)[] = [];
    const conversationIds: (string | null)[] = [];
    const messageIds: string[] = [];
    const messageCreatedAts: string[] = [];
    const dirtyKeysFlushed: string[] = [];
    const dirtyKeysStale: string[] = [];

    for (let j = 0; j < batch.length; j++) {
      const dirtyKey = batch[j];
      const [pipeErr, data] = results[j];
      if (pipeErr || !data || !data.msg_id || !data.msg_created_at) {
        dirtyKeysStale.push(dirtyKey);
        continue;
      }

      const [userId] = dirtyKey.split('|');
      userIds.push(userId);
      channelIds.push(data.channel_id || null);
      conversationIds.push(data.conversation_id || null);
      messageIds.push(data.msg_id);
      messageCreatedAts.push(data.msg_created_at);
      dirtyKeysFlushed.push(dirtyKey);
    }

    if (userIds.length > 0) {
      try {
        await query(READ_STATE_BATCH_UPSERT_SQL, [
          userIds,
          channelIds,
          conversationIds,
          messageIds,
          messageCreatedAts,
        ]);
      } catch (err: any) {
        logger.debug({ err }, 'read_state batch flush query failed');
        continue;
      }
    }

    const toClear = [...dirtyKeysFlushed, ...dirtyKeysStale];
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
}

function startReadStateFlushInterval(intervalMs: number = READ_STATE_FLUSH_INTERVAL_MS): void {
  setInterval(flushDirtyReadStatesToDB, intervalMs).unref();
}

module.exports = {
  enqueueBatchReadStateUpdate,
  flushDirtyReadStatesToDB,
  startReadStateFlushInterval,
};
