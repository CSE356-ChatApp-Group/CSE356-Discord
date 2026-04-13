/**
 * Keep channels.conversations last_message_* in sync after hard-deletes.
 * Concurrent deletes can cause FK 23503 on repoint; we clear and retry.
 */

'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');
const { messageLastMessageRepointFkRetryTotal } = require('../utils/metrics');

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
};
