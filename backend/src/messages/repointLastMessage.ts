/**
 * Keep channels.conversations last_message_* in sync after hard-deletes.
 * Concurrent deletes can cause FK 23503 on repoint; we clear and retry.
 */

'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const { messageLastMessageRepointFkRetryTotal } = require('../utils/metrics');
const sideEffects = require('./sideEffects');

// Redis keys for deferred channel last_message pointer updates.
// Hot path writes to Redis (loopback); a background interval batch-flushes to DB.
const CH_LAST_MSG_KEY_PREFIX = 'ch:last_msg:';
const CH_LAST_MSG_DIRTY_SET  = 'ch:last_msg:dirty';

const CHANNEL_FLUSH_INTERVAL_MS = parseInt(
  process.env.CHANNEL_LAST_MSG_FLUSH_INTERVAL_MS || '10000', 10
);
const CHANNEL_FLUSH_BATCH_SIZE = 50;

// SQL for background flush — no 1 ms lock_timeout, normal lock wait is fine
// because this runs out of the hot path.
// EXISTS guard prevents FK violation when the message is deleted in the ~10s
// window between the Redis write and this batch flush.
const CHANNEL_LAST_MESSAGE_FLUSH_SQL = `
  UPDATE channels
     SET last_message_id = $1,
         last_message_author_id = $2,
         last_message_at = $3
   WHERE id = $4
     AND (last_message_at IS NULL OR $3 >= last_message_at)
     AND EXISTS (SELECT 1 FROM messages WHERE id = $1)`;

async function clearChannelLastMessagePointers(channelId: string) {
  await query(
    `UPDATE channels
     SET last_message_id = NULL, last_message_author_id = NULL, last_message_at = NULL
     WHERE id = $1`,
    [channelId],
  );
}

async function clearConversationLastMessagePointers(conversationId: string) {
  await query(
    `UPDATE conversations
     SET last_message_id = NULL, last_message_author_id = NULL, last_message_at = NULL
     WHERE id = $1`,
    [conversationId],
  );
}

const CHANNEL_REPOINT_SQL = `WITH lm AS (
       SELECT m.id, m.author_id, m.created_at
       FROM messages m
       WHERE m.channel_id = $1 AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
       FOR KEY SHARE
     )
     UPDATE channels ch
     SET last_message_id = lm.id,
         last_message_author_id = lm.author_id,
         last_message_at = lm.created_at
     FROM lm
     WHERE ch.id = $1`;

const CONVERSATION_REPOINT_SQL = `WITH lm AS (
       SELECT m.id, m.author_id, m.created_at
       FROM messages m
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT 1
       FOR KEY SHARE
     )
     UPDATE conversations conv
     SET last_message_id = lm.id,
         last_message_author_id = lm.author_id,
         last_message_at = lm.created_at,
         updated_at = NOW()
     FROM lm
     WHERE conv.id = $1`;

const pendingChannelLastMessageUpdates = new Map<
  string,
  { messageId: string; authorId: string; createdAt: string | Date }
>();
const queuedChannelLastMessageUpdates = new Set<string>();

function lastMessagePointerSortValue(createdAt: string | Date) {
  const millis = new Date(createdAt).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function shouldReplacePendingChannelLastMessageUpdate(
  current: { messageId: string; authorId: string; createdAt: string | Date } | undefined,
  next: { messageId: string; authorId: string; createdAt: string | Date },
) {
  if (!current) return true;
  const currentTime = lastMessagePointerSortValue(current.createdAt);
  const nextTime = lastMessagePointerSortValue(next.createdAt);
  if (nextTime !== currentTime) return nextTime > currentTime;
  return String(next.messageId) > String(current.messageId);
}

async function flushChannelLastMessageUpdate(channelId: string) {
  // Write to Redis (loopback, sub-ms) instead of the DB.
  // A background interval batch-flushes all dirty channels to DB every
  // CHANNEL_FLUSH_INTERVAL_MS ms, eliminating hot-row contention on channels.
  while (true) {
    const pending = pendingChannelLastMessageUpdates.get(channelId);
    if (!pending) return;
    pendingChannelLastMessageUpdates.delete(channelId);

    const atStr = typeof pending.createdAt === 'string'
      ? pending.createdAt
      : (pending.createdAt as Date).toISOString();

    try {
      await redis.hset(
        `${CH_LAST_MSG_KEY_PREFIX}${channelId}`,
        'msg_id',    pending.messageId,
        'author_id', pending.authorId,
        'at',        atStr,
      );
      await redis.sadd(CH_LAST_MSG_DIRTY_SET, channelId);
    } catch (err: any) {
      // Redis is loopback — failures are rare. Skip; the bg flush will
      // carry whatever the previous Redis value was (or nothing if cold).
      logger.warn({ err, channelId }, 'channel last_message Redis write failed');
      return;
    }

    // Loop back if another update arrived while we were writing
    if (!pendingChannelLastMessageUpdates.has(channelId)) return;
  }
}

async function flushDirtyChannelsToDB() {
  let channelIds: string[];
  try {
    channelIds = await redis.smembers(CH_LAST_MSG_DIRTY_SET);
  } catch { return; }

  if (channelIds.length === 0) return;

  // Remove from dirty set before flushing so a crash mid-flush does not
  // re-flush stale data; the next message write will re-dirty the channel.
  try {
    await (channelIds.length === 1
      ? redis.srem(CH_LAST_MSG_DIRTY_SET, channelIds[0])
      : redis.srem(CH_LAST_MSG_DIRTY_SET, ...channelIds));
  } catch { return; }

  for (let i = 0; i < channelIds.length; i += CHANNEL_FLUSH_BATCH_SIZE) {
    const batch = channelIds.slice(i, i + CHANNEL_FLUSH_BATCH_SIZE);
    const pipeline = redis.pipeline();
    for (const id of batch) pipeline.hgetall(`${CH_LAST_MSG_KEY_PREFIX}${id}`);
    let results: [Error | null, Record<string, string>][];
    try {
      results = await pipeline.exec();
    } catch { continue; }

    for (let j = 0; j < batch.length; j++) {
      const channelId = batch[j];
      const [pipeErr, data] = results[j];
      if (pipeErr || !data || !data.msg_id) continue;
      query(CHANNEL_LAST_MESSAGE_FLUSH_SQL, [data.msg_id, data.author_id, data.at, channelId])
        .catch((qErr) => logger.debug(
          { err: qErr, channelId },
          'channel last_msg bg flush query failed',
        ));
    }
  }
}

function startChannelLastMessageFlushInterval() {
  setInterval(flushDirtyChannelsToDB, CHANNEL_FLUSH_INTERVAL_MS).unref();
}

function scheduleChannelLastMessagePointerUpdate(
  channelId: string,
  payload: { messageId: string; authorId: string; createdAt: string | Date },
) {
  const current = pendingChannelLastMessageUpdates.get(channelId);
  if (!shouldReplacePendingChannelLastMessageUpdate(current, payload)) {
    return true;
  }
  pendingChannelLastMessageUpdates.set(channelId, payload);

  if (queuedChannelLastMessageUpdates.has(channelId)) {
    return true;
  }
  queuedChannelLastMessageUpdates.add(channelId);

  return sideEffects.enqueueFanoutJob('last_message.channel_pointer', async () => {
    try {
      await flushChannelLastMessageUpdate(channelId);
    } finally {
      queuedChannelLastMessageUpdates.delete(channelId);
      if (pendingChannelLastMessageUpdates.has(channelId)) {
        scheduleChannelLastMessagePointerUpdate(
          channelId,
          pendingChannelLastMessageUpdates.get(channelId)!,
        );
      }
    }
  });
}

async function repointChannelLastMessage(channelId: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const { rowCount } = await query(CHANNEL_REPOINT_SQL, [channelId]);
      if (!rowCount) {
        await clearChannelLastMessagePointers(channelId);
      }
      return;
    } catch (err: any) {
      if (err?.code !== '23503') throw err;
      messageLastMessageRepointFkRetryTotal.inc({ scope: 'channel' });
      if (attempt >= 3) {
        logger.warn(
          { channelId, attempt, detail: err.detail },
          'repointChannelLastMessage: FK persists after retries; nulling last_message (delete already committed)',
        );
        await clearChannelLastMessagePointers(channelId);
        return;
      }
      logger.warn(
        { channelId, attempt, detail: err.detail },
        'repointChannelLastMessage: FK race, clearing last_message pointers and retrying',
      );
      await clearChannelLastMessagePointers(channelId);
    }
  }
}

async function repointConversationLastMessage(conversationId: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const { rowCount } = await query(CONVERSATION_REPOINT_SQL, [conversationId]);
      if (!rowCount) {
        await clearConversationLastMessagePointers(conversationId);
      }
      return;
    } catch (err: any) {
      if (err?.code !== '23503') throw err;
      messageLastMessageRepointFkRetryTotal.inc({ scope: 'conversation' });
      if (attempt >= 3) {
        logger.warn(
          { conversationId, attempt, detail: err.detail },
          'repointConversationLastMessage: FK persists after retries; nulling last_message (delete already committed)',
        );
        await clearConversationLastMessagePointers(conversationId);
        return;
      }
      logger.warn(
        { conversationId, attempt, detail: err.detail },
        'repointConversationLastMessage: FK race, clearing last_message pointers and retrying',
      );
      await clearConversationLastMessagePointers(conversationId);
    }
  }
}

module.exports = {
  repointChannelLastMessage,
  repointConversationLastMessage,
  scheduleChannelLastMessagePointerUpdate,
  startChannelLastMessageFlushInterval,
};
