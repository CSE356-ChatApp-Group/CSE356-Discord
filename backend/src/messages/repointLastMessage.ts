/**
 * Keep channels.conversations last_message_* in sync after hard-deletes.
 * Concurrent deletes can cause FK 23503 on repoint; we clear and retry.
 */

'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const logger = require('../utils/logger');
const {
  messageLastMessageRepointFkRetryTotal,
  channelLastMessageUpdateDeferredTotal,
  channelLastMessageUpdateFlushedTotal,
  channelLastMessageUpdateFailedTotal,
  lastMessageRedisUpdateTotal,
  lastMessagePgReconcileTotal,
  lastMessagePgReconcileSkippedTotal,
  lastMessageCacheTotal,
} = require('../utils/metrics');
const sideEffects = require('./sideEffects');
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require('./messageInsertLockPressure');

// Redis keys for deferred channel last_message pointer updates.
// Hot path writes to Redis (loopback); a background interval batch-flushes to DB.
const CH_LAST_MSG_KEY_PREFIX = 'ch:last_msg:';
const CH_LAST_MSG_DIRTY_SET  = 'ch:last_msg:dirty';

// Redis keys for deferred conversation last_message pointer updates (same pattern).
const CONV_LAST_MSG_KEY_PREFIX = 'conv:last_msg:';
const CONV_LAST_MSG_DIRTY_SET  = 'conv:last_msg:dirty';

const LAST_MESSAGE_REDIS_TTL_SECS = (() => {
  const raw = parseInt(process.env.LAST_MESSAGE_REDIS_TTL_SECS || '43200', 10);
  if (!Number.isFinite(raw) || raw < 300) return 43_200;
  return Math.min(86_400 * 30, raw);
})();

const CHANNEL_FLUSH_INTERVAL_MS = parseInt(
  process.env.CHANNEL_LAST_MSG_FLUSH_INTERVAL_MS || '10000', 10
);
const CHANNEL_FLUSH_BATCH_SIZE = 50;

/** Primary env wins when both primary and legacy are set (including `primary=` empty). */
function parseBoolEnv(primary: string, legacyAlias?: string): boolean {
  if (process.env[primary] !== undefined) {
    return String(process.env[primary]).toLowerCase() === 'true';
  }
  if (legacyAlias !== undefined && process.env[legacyAlias] !== undefined) {
    return String(process.env[legacyAlias]).toLowerCase() === 'true';
  }
  return false;
}

/** DB writes for channel last_message_* (flush + delete repoint). Alias matches ops naming. */
const LAST_MESSAGE_PG_RECONCILE_ENABLED = parseBoolEnv(
  'LAST_MESSAGE_PG_RECONCILE_ENABLED',
  'CHANNEL_LAST_MESSAGE_PG_RECONCILE_ENABLED',
);
/** DB writes for conversation last_message_* (flush + delete repoint). */
const CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED = parseBoolEnv(
  'CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED',
);

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

const CONVERSATION_LAST_MESSAGE_FLUSH_SQL = `
  UPDATE conversations
     SET last_message_id = $1,
         last_message_author_id = $2,
         last_message_at = $3,
         updated_at = NOW()
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

type LastMessagePayload = { messageId: string; authorId: string | null; createdAt: string | Date };

const pendingChannelLastMessageUpdates = new Map<string, LastMessagePayload>();
const queuedChannelLastMessageUpdates = new Set<string>();

const pendingConversationLastMessageUpdates = new Map<string, LastMessagePayload>();
const queuedConversationLastMessageUpdates = new Set<string>();

function lastMessagePointerSortValue(createdAt: string | Date) {
  const millis = new Date(createdAt).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

function shouldReplaceLastMessageUpdate(
  current: LastMessagePayload | undefined,
  next: LastMessagePayload,
) {
  if (!current) return true;
  const currentTime = lastMessagePointerSortValue(current.createdAt);
  const nextTime = lastMessagePointerSortValue(next.createdAt);
  if (nextTime !== currentTime) return nextTime > currentTime;
  return String(next.messageId) > String(current.messageId);
}

async function flushLastMessageToRedis(
  keyPrefix: string,
  dirtySet: string,
  id: string,
  pending: { messageId: string; authorId: string | null; createdAt: string | Date },
  logLabel: string,
): Promise<boolean> {
  const atStr = typeof pending.createdAt === 'string'
    ? pending.createdAt
    : (pending.createdAt as Date).toISOString();
  try {
    const key = `${keyPrefix}${id}`;
    await redis.hset(
      key,
      'msg_id',    pending.messageId,
      'author_id', pending.authorId ?? '',
      'at',        atStr,
    );
    if (typeof redis.expire === 'function') {
      try {
        await redis.expire(key, LAST_MESSAGE_REDIS_TTL_SECS);
      } catch (expireErr: any) {
        logger.warn({ err: expireErr, id }, `${logLabel} last_message Redis expire failed`);
      }
    }
    await redis.sadd(dirtySet, id);
    lastMessageRedisUpdateTotal.inc({ target: logLabel, result: 'ok' });
    return true;
  } catch (err: any) {
    logger.warn({ err, id }, `${logLabel} last_message Redis write failed`);
    lastMessageRedisUpdateTotal.inc({ target: logLabel, result: 'error' });
    return false;
  }
}

async function flushChannelLastMessageUpdate(channelId: string) {
  // Write to Redis (loopback, sub-ms) instead of the DB.
  // A background interval batch-flushes all dirty channels to DB every
  // CHANNEL_FLUSH_INTERVAL_MS ms, eliminating hot-row contention on channels.
  while (true) {
    const pending = pendingChannelLastMessageUpdates.get(channelId);
    if (!pending) return;
    pendingChannelLastMessageUpdates.delete(channelId);

    const ok = await flushLastMessageToRedis(
      CH_LAST_MSG_KEY_PREFIX,
      CH_LAST_MSG_DIRTY_SET,
      channelId,
      pending,
      'channel',
    );
    if (!ok) {
      channelLastMessageUpdateFailedTotal.inc({ target: 'channel' });
      return;
    }

    // Loop back if another update arrived while we were writing
    if (!pendingChannelLastMessageUpdates.has(channelId)) return;
  }
}

async function flushConversationLastMessageUpdate(conversationId: string) {
  while (true) {
    const pending = pendingConversationLastMessageUpdates.get(conversationId);
    if (!pending) return;
    pendingConversationLastMessageUpdates.delete(conversationId);

    const ok = await flushLastMessageToRedis(
      CONV_LAST_MSG_KEY_PREFIX,
      CONV_LAST_MSG_DIRTY_SET,
      conversationId,
      pending,
      'conversation',
    );
    if (!ok) {
      channelLastMessageUpdateFailedTotal.inc({ target: 'conversation' });
      return;
    }

    if (!pendingConversationLastMessageUpdates.has(conversationId)) return;
  }
}

async function flushDirtyTargetsToDB(
  dirtySetKey: string,
  keyPrefix: string,
  sql: string,
  target: 'channel' | 'conversation',
) {
  if (target === 'channel' && !LAST_MESSAGE_PG_RECONCILE_ENABLED) {
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'channel_disabled' });
    return;
  }
  if (target === 'conversation' && !CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED) {
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'conversation_disabled' });
    return;
  }
  if (getShouldDeferReadReceiptForInsertLockPressure()) {
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'insert_lock_pressure' });
    return;
  }
  let ids: string[];
  try {
    ids = await redis.smembers(dirtySetKey);
  } catch { return; }

  if (ids.length === 0) return;

  // Remove from dirty set before flushing so a crash mid-flush does not
  // re-flush stale data; the next message write will re-dirty the entry.
  try {
    await (ids.length === 1
      ? redis.srem(dirtySetKey, ids[0])
      : redis.srem(dirtySetKey, ...ids));
  } catch { return; }

  for (let i = 0; i < ids.length; i += CHANNEL_FLUSH_BATCH_SIZE) {
    const batch = ids.slice(i, i + CHANNEL_FLUSH_BATCH_SIZE);
    const pipeline = redis.pipeline();
    for (const id of batch) pipeline.hgetall(`${keyPrefix}${id}`);
    let results: [Error | null, Record<string, string>][];
    try {
      results = await pipeline.exec();
    } catch { continue; }

    const batchQueries: Promise<unknown>[] = [];
    for (let j = 0; j < batch.length; j++) {
      const id = batch[j];
      const [pipeErr, data] = results[j];
      if (pipeErr || !data || !data.msg_id) continue;
      // authorId stored as '' for null (system messages); restore null.
      const authorId = data.author_id === '' ? null : data.author_id;
      batchQueries.push(
        query(sql, [data.msg_id, authorId, data.at, id])
          .then(() => {
            channelLastMessageUpdateFlushedTotal.inc({ target });
            lastMessagePgReconcileTotal.inc({ target, result: 'ok' });
          })
          .catch((qErr: any) => {
            channelLastMessageUpdateFailedTotal.inc({ target });
            lastMessagePgReconcileTotal.inc({ target, result: 'error' });
            logger.debug({ err: qErr, id }, `${target} last_msg bg flush query failed`);
          }),
      );
    }
    if (batchQueries.length) await Promise.all(batchQueries);
  }
}

function startChannelLastMessageFlushInterval() {
  setInterval(() => {
    void flushDirtyTargetsToDB(
      CH_LAST_MSG_DIRTY_SET,
      CH_LAST_MSG_KEY_PREFIX,
      CHANNEL_LAST_MESSAGE_FLUSH_SQL,
      'channel',
    );
    void flushDirtyTargetsToDB(
      CONV_LAST_MSG_DIRTY_SET,
      CONV_LAST_MSG_KEY_PREFIX,
      CONVERSATION_LAST_MESSAGE_FLUSH_SQL,
      'conversation',
    );
  }, CHANNEL_FLUSH_INTERVAL_MS).unref();
}

function scheduleChannelLastMessagePointerUpdate(
  channelId: string,
  payload: { messageId: string; authorId: string; createdAt: string | Date },
) {
  const current = pendingChannelLastMessageUpdates.get(channelId);
  if (!shouldReplaceLastMessageUpdate(current, payload)) {
    return true;
  }
  pendingChannelLastMessageUpdates.set(channelId, payload);
  channelLastMessageUpdateDeferredTotal.inc({ target: 'channel' });

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

function scheduleConversationLastMessagePointerUpdate(
  conversationId: string,
  payload: { messageId: string; authorId: string | null; createdAt: string | Date },
) {
  const current = pendingConversationLastMessageUpdates.get(conversationId);
  if (!shouldReplaceLastMessageUpdate(current, payload)) {
    return true;
  }
  pendingConversationLastMessageUpdates.set(conversationId, payload);
  channelLastMessageUpdateDeferredTotal.inc({ target: 'conversation' });

  if (queuedConversationLastMessageUpdates.has(conversationId)) {
    return true;
  }
  queuedConversationLastMessageUpdates.add(conversationId);

  return sideEffects.enqueueFanoutJob('last_message.conversation_pointer', async () => {
    try {
      await flushConversationLastMessageUpdate(conversationId);
    } finally {
      queuedConversationLastMessageUpdates.delete(conversationId);
      if (pendingConversationLastMessageUpdates.has(conversationId)) {
        scheduleConversationLastMessagePointerUpdate(
          conversationId,
          pendingConversationLastMessageUpdates.get(conversationId)!,
        );
      }
    }
  });
}

async function repointChannelLastMessage(channelId: string) {
  if (!LAST_MESSAGE_PG_RECONCILE_ENABLED) {
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'channel_repoint_disabled' });
    return;
  }
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
  if (!CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED) {
    lastMessagePgReconcileSkippedTotal.inc({ reason: 'conversation_repoint_disabled' });
    return;
  }
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

async function flushDirtyLastMessagePointers() {
  await Promise.all([
    flushDirtyTargetsToDB(
      CH_LAST_MSG_DIRTY_SET,
      CH_LAST_MSG_KEY_PREFIX,
      CHANNEL_LAST_MESSAGE_FLUSH_SQL,
      'channel',
    ),
    flushDirtyTargetsToDB(
      CONV_LAST_MSG_DIRTY_SET,
      CONV_LAST_MSG_KEY_PREFIX,
      CONVERSATION_LAST_MESSAGE_FLUSH_SQL,
      'conversation',
    ),
  ]);
}

type LastMessageMeta = {
  msg_id?: string;
  author_id?: string;
  at?: string;
};

async function getChannelLastMessageMetaMapFromRedis(
  channelIds: string[],
  target: 'channel' | 'community_channel' = 'channel',
) {
  const out = new Map<string, LastMessageMeta>();
  if (!Array.isArray(channelIds) || channelIds.length === 0) return out;
  const ids = [...new Set(channelIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return out;
  try {
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(`${CH_LAST_MSG_KEY_PREFIX}${id}`);
    const results = await pipeline.exec();
    for (let i = 0; i < ids.length; i += 1) {
      const [err, data] = results[i] || [];
      if (err || !data || !data.msg_id) {
        lastMessageCacheTotal.inc({ target, result: err ? 'error' : 'miss' });
        continue;
      }
      out.set(ids[i], data as LastMessageMeta);
      lastMessageCacheTotal.inc({ target, result: 'hit' });
    }
  } catch {
    for (const _id of ids) {
      lastMessageCacheTotal.inc({ target, result: 'error' });
    }
  }
  return out;
}

async function getConversationLastMessageMetaMapFromRedis(conversationIds: string[]) {
  const out = new Map<string, LastMessageMeta>();
  if (!Array.isArray(conversationIds) || conversationIds.length === 0) return out;
  const ids = [...new Set(conversationIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return out;
  try {
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(`${CONV_LAST_MSG_KEY_PREFIX}${id}`);
    const results = await pipeline.exec();
    for (let i = 0; i < ids.length; i += 1) {
      const [err, data] = results[i] || [];
      if (err || !data || !data.msg_id) {
        lastMessageCacheTotal.inc({ target: 'conversation', result: err ? 'error' : 'miss' });
        continue;
      }
      out.set(ids[i], data as LastMessageMeta);
      lastMessageCacheTotal.inc({ target: 'conversation', result: 'hit' });
    }
  } catch {
    for (const _id of ids) {
      lastMessageCacheTotal.inc({ target: 'conversation', result: 'error' });
    }
  }
  return out;
}

module.exports = {
  repointChannelLastMessage,
  repointConversationLastMessage,
  scheduleChannelLastMessagePointerUpdate,
  scheduleConversationLastMessagePointerUpdate,
  startChannelLastMessageFlushInterval,
  flushDirtyLastMessagePointers,
  getChannelLastMessageMetaMapFromRedis,
  getConversationLastMessageMetaMapFromRedis,
};
