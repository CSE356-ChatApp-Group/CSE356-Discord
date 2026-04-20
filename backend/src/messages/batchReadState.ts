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
  SELECT
    UNNEST($1::uuid[]),
    UNNEST($2::uuid[]),
    UNNEST($3::uuid[]),
    UNNEST($4::uuid[]),
    UNNEST($5::timestamptz[]),
    NOW()
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
    await redis.hset(
      pendingKey,
      'msg_id',         messageId,
      'msg_created_at', createdAtStr,
      'channel_id',     channelId ?? '',
      'conversation_id', conversationId ?? '',
    );
    await redis.sadd(RS_DIRTY_SET, dirtyKey);
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

  // Remove from dirty set before fetching data — prevents re-flushing stale
  // data if we crash mid-flush; next enqueue will re-dirty the entry.
  try {
    if (dirtyKeys.length === 1) {
      await redis.srem(RS_DIRTY_SET, dirtyKeys[0]);
    } else {
      await redis.srem(RS_DIRTY_SET, ...dirtyKeys);
    }
  } catch {
    return;
  }

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

    for (let j = 0; j < batch.length; j++) {
      const [pipeErr, data] = results[j];
      if (pipeErr || !data || !data.msg_id || !data.msg_created_at) continue;

      const [userId] = batch[j].split('|');
      userIds.push(userId);
      channelIds.push(data.channel_id || null);
      conversationIds.push(data.conversation_id || null);
      messageIds.push(data.msg_id);
      messageCreatedAts.push(data.msg_created_at);
    }

    if (userIds.length === 0) continue;

    query(READ_STATE_BATCH_UPSERT_SQL, [
      userIds,
      channelIds,
      conversationIds,
      messageIds,
      messageCreatedAts,
    ]).catch((err: any) => {
      logger.debug({ err }, 'read_state batch flush query failed');
    });
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
