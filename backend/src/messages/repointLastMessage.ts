/**
 * Keep channels.conversations last_message_* in sync after hard-deletes.
 * Concurrent deletes can cause FK 23503 on repoint; we clear and retry.
 */

'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');
const { messageLastMessageRepointFkRetryTotal } = require('../utils/metrics');
const sideEffects = require('./sideEffects');

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

const CHANNEL_LAST_MESSAGE_UPDATE_SQL = `WITH lock_guard AS (
       SELECT set_config('lock_timeout', '1ms', true)
     )
     UPDATE channels
        SET last_message_id = $1,
            last_message_author_id = $2,
            last_message_at = $3
       FROM lock_guard
      WHERE id = $4
        AND (last_message_at IS NULL OR $3 >= last_message_at)`;

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
  while (true) {
    const pending = pendingChannelLastMessageUpdates.get(channelId);
    if (!pending) return;
    pendingChannelLastMessageUpdates.delete(channelId);

    try {
      await query(CHANNEL_LAST_MESSAGE_UPDATE_SQL, [
        pending.messageId,
        pending.authorId,
        pending.createdAt,
        channelId,
      ]);
    } catch (err) {
      logger.warn(
        { err, channelId, messageId: pending.messageId },
        'scheduleChannelLastMessagePointerUpdate: async update failed',
      );
    }

    if (!pendingChannelLastMessageUpdates.has(channelId)) return;
  }
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
};
