/**
 * Messages router
 *
 * GET    /api/v1/messages?channelId=&before=&limit=   – paginated history
 * POST   /api/v1/messages                             – create
 * PATCH  /api/v1/messages/:id                         – edit
 * DELETE /api/v1/messages/:id                         – hard-delete
 * PUT    /api/v1/messages/:id/read                    – mark as read
 */

'use strict';

const express = require('express');
const { body, query: qv, param, validationResult } = require('express-validator');

const { query, getClient } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const sideEffects      = require('./sideEffects');
const overload         = require('../utils/overload');
const redis            = require('../db/redis');
const logger           = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ── Helpers ────────────────────────────────────────────────────────────────────

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ errors: errors.array() }); return false; }
  return true;
}

/** Build the Redis pub/sub channel key for a message target */
function targetKey(channelId, conversationId) {
  if (channelId)      return `channel:${channelId}`;
  if (conversationId) return `conversation:${conversationId}`;
  throw new Error('No target');
}

async function ensureActiveConversationParticipant(conversationId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId]
  );
  return rows.length > 0;
}

async function ensureChannelAccess(channelId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM channels c
     WHERE c.id = $1
       AND (
         c.is_private = FALSE
         OR EXISTS (
           SELECT 1
           FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = $2
         )
       )`,
    [channelId, userId]
  );
  return rows.length > 0;
}

async function ensureMessageAccess({ channelId, conversationId }, userId) {
  if (conversationId) return ensureActiveConversationParticipant(conversationId, userId);
  if (channelId) return ensureChannelAccess(channelId, userId);
  return false;
}

async function getConversationFanoutTargets(conversationId) {
  const { rows } = await query(
    `SELECT user_id::text AS user_id
     FROM conversation_participants
     WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );

  return [
    `conversation:${conversationId}`,
    ...rows.map((row) => `user:${row.user_id}`),
  ];
}

async function publishConversationEvent(conversationId, event, data) {
  const targets = await getConversationFanoutTargets(conversationId);
  const uniqueTargets = [...new Set(targets)];
  uniqueTargets.forEach((target) => {
    sideEffects.publishMessageEvent(target, event, data);
  });
  // Bust each participant's GET /conversations cache so last_message_at and
  // sort order reflect the new event immediately on the next REST request.
  // User IDs are already present in targets as 'user:<id>' entries — no extra
  // DB query needed.
  const userIds = uniqueTargets.filter((t) => t.startsWith('user:')).map((t) => t.slice(5));
  Promise.allSettled(userIds.map((uid) => redis.del(`conversations:list:${uid}`))).catch(() => {});
}

async function loadHydratedMessageById(messageId) {
  const { rows } = await query(
    `SELECT m.*,
            CASE WHEN u.id IS NULL THEN NULL ELSE row_to_json(u.*) END AS author,
            COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM messages m
     LEFT JOIN users u ON u.id = m.author_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, u.id`,
    [messageId]
  );
  return rows[0] || null;
}

async function loadMessageTarget(messageId) {
  const { rows } = await query(
    `SELECT id, author_id, channel_id, conversation_id
     FROM messages
     WHERE id = $1 AND deleted_at IS NULL`,
    [messageId]
  );
  return rows[0] || null;
}

// ── Helpers ── message cache ─────────────────────────────────────────────────
const MESSAGES_CACHE_TTL_SECS = 5;
function channelMsgCacheKey(channelId) { return `messages:channel:${channelId}`; }

// ── GET /messages ──────────────────────────────────────────────────────────────
router.get('/',
  qv('channelId').optional().isUUID(),
  qv('conversationId').optional().isUUID(),
  qv('before').optional().isUUID(),          // cursor-based pagination
  qv('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      const { channelId, conversationId, before } = req.query;
      const requestedLimit = Number(req.query.limit || 50);
      const limit = overload.historyLimit(requestedLimit);

      if (!channelId && !conversationId) {
        return res.status(400).json({ error: 'channelId or conversationId required' });
      }

      // Serve the most-recent page of a public/member channel from a short-lived
      // Redis cache.  All users in a channel see the same messages, so a single
      // shared key is correct.  Pagination (before=) and DMs are not cached.
      if (channelId && !before) {
        try {
          const cached = await redis.get(channelMsgCacheKey(channelId));
          if (cached) return res.json(JSON.parse(cached));
        } catch { /* cache miss – fall through */ }
      }

      // Build a single query that enforces access control and returns messages in one pool checkout.
      const params: any[] = [limit, req.user.id];

      let accessWhere: string;
      let targetWhere: string;

      if (channelId) {
        params.push(channelId);
        const ci = params.length; // $3
        accessWhere = `EXISTS (
          SELECT 1 FROM channels c
          WHERE c.id = $${ci}
            AND (c.is_private = FALSE
                 OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
        )`;
        targetWhere = `m.channel_id = $${ci}`;
      } else {
        params.push(conversationId);
        const ci = params.length; // $3
        accessWhere = `EXISTS (
          SELECT 1 FROM conversation_participants cp
          WHERE cp.conversation_id = $${ci} AND cp.user_id = $2 AND cp.left_at IS NULL
        )`;
        targetWhere = `m.conversation_id = $${ci}`;
      }

      if (before) {
        params.push(before);
        targetWhere += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
      }

      const sql = `
        SELECT m.*,
               CASE WHEN u.id IS NULL THEN NULL ELSE row_to_json(u.*) END AS author,
               COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
        FROM   messages m
        LEFT JOIN users u ON u.id = m.author_id
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE  ${targetWhere} AND m.deleted_at IS NULL
          AND  ${accessWhere}
        GROUP  BY m.id, u.id
        ORDER  BY m.created_at DESC
        LIMIT  $1
      `;

      const { rows } = await query(sql, params);

      if (rows.length === 0) {
        // Distinguish "no messages" from "access denied" with a lightweight check.
        const accessCheck = await query(
          channelId
            ? `SELECT 1 FROM channels WHERE id = $1 AND (is_private = FALSE OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2))`
            : `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [channelId ?? conversationId, req.user.id]
        );
        if (!accessCheck.rows.length) return res.status(403).json({ error: channelId ? 'Access denied' : 'Not a participant' });
      }

      const body = { messages: rows.reverse() }; // return in chronological order
      if (channelId && !before) {
        redis.set(channelMsgCacheKey(channelId), JSON.stringify(body), 'EX', MESSAGES_CACHE_TTL_SECS).catch(() => {});
      }
      res.json(body);
    } catch (err) { next(err); }
  }
);

// ── POST /messages ─────────────────────────────────────────────────────────────
const ALLOWED_ATTACHMENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
router.post('/',
  body('content').optional().isString().isLength({ max: 4000 }),
  body('channelId').optional().isUUID(),
  body('conversationId').optional().isUUID(),
  body('threadId').optional().isUUID(),
  body('attachments').optional().isArray({ max: MAX_ATTACHMENTS_PER_MESSAGE }),
  body('attachments.*.storageKey').optional().isString().isLength({ max: 512 }),
  body('attachments.*.filename').optional().isString().isLength({ max: 255 }),
  body('attachments.*.contentType').optional().custom((value) => ALLOWED_ATTACHMENT_TYPES.has(value)),
  body('attachments.*.sizeBytes').optional().isInt({ min: 1, max: 8 * 1024 * 1024 }),
  body('attachments.*.width').optional().isInt({ min: 1 }),
  body('attachments.*.height').optional().isInt({ min: 1 }),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    let client;
    try {
      client = await getClient();
      const { content, channelId, conversationId, threadId } = req.body;
      const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];

      if (!channelId && !conversationId) {
        return res.status(400).json({ error: 'channelId or conversationId required' });
      }
      if (!content?.trim() && attachments.length === 0) {
        return res.status(400).json({ error: 'content or at least one attachment is required' });
      }

      const invalidAttachment = attachments.find((attachment) => (
        !attachment
        || typeof attachment.storageKey !== 'string'
        || !attachment.storageKey.trim()
        || typeof attachment.filename !== 'string'
        || !attachment.filename.trim()
        || !ALLOWED_ATTACHMENT_TYPES.has(attachment.contentType)
        || !Number.isInteger(Number(attachment.sizeBytes))
        || Number(attachment.sizeBytes) <= 0
        || Number(attachment.sizeBytes) > 8 * 1024 * 1024
      ));

      if (invalidAttachment) {
        return res.status(400).json({ error: 'attachments must include storageKey, filename, contentType, and sizeBytes' });
      }

      if (conversationId) {
        const { rows: [p] } = await client.query(
          `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [conversationId, req.user.id]
        );
        if (!p) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Not a participant' });
        }
      }

      let communityId: string | null = null;
      if (channelId) {
        const { rows: [ch] } = await client.query(
          `SELECT community_id FROM channels WHERE id = $1
           AND (is_private = FALSE
             OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2))`,
          [channelId, req.user.id]
        );
        if (!ch) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Access denied' });
        }
        communityId = ch.community_id;
      }

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO messages (channel_id, conversation_id, author_id, content, thread_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [channelId || null, conversationId || null, req.user.id, content?.trim() || null, threadId || null]
      );
      const baseMessage = rows[0];

      if (attachments.length > 0) {
        const values = [];
        const params = [];
        let index = 1;

        for (const attachment of attachments) {
          values.push(
            `($${index++}, $${index++}, 'image', $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`
          );
          params.push(
            baseMessage.id,
            req.user.id,
            attachment.filename,
            attachment.contentType,
            attachment.sizeBytes,
            attachment.storageKey,
            attachment.width || null,
            attachment.height || null
          );
        }

        await client.query(
          `INSERT INTO attachments
             (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key, width, height)
           VALUES ${values.join(', ')}`,
          params
        );
      }

      await client.query('COMMIT');

      // Load hydrated message on the same client connection (no extra checkout)
      const { rows: [message] } = await client.query(
        `SELECT m.*,
                CASE WHEN u.id IS NULL THEN NULL ELSE row_to_json(u.*) END AS author,
                COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
         FROM   messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN attachments a ON a.message_id = m.id
         WHERE  m.id = $1
         GROUP  BY m.id, u.id`,
        [baseMessage.id]
      );

      // Release the pool connection before fanout/side-effects so it doesn't
      // hold a slot while publishConversationEvent does its own query().
      client.release();
      client = null;

      // Bust the channel message cache so the next reader sees the new message.
      if (channelId) {
        redis.del(channelMsgCacheKey(channelId)).catch(() => {});
      }

      sideEffects.indexMessage(baseMessage);
      if (conversationId) {
        await publishConversationEvent(conversationId, 'message:created', message || baseMessage);
      } else {
        sideEffects.publishMessageEventWithUnread(
          targetKey(channelId, conversationId),
          'message:created',
          message || baseMessage,
          channelId
        );
      }
      if (communityId) {
        sideEffects.publishMessageEvent(`community:${communityId}`, 'community:channel_message', {
          communityId,
          channelId,
          messageId: baseMessage.id,
          authorId: baseMessage.author_id,
          createdAt: baseMessage.created_at,
        });
      }

      res.status(201).json({ message: message || baseMessage });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
        }
      }
      next(err);
    } finally {
      client?.release();
    }
  }
);

// ── PATCH /messages/:id ────────────────────────────────────────────────────────
router.patch('/:id',
  param('id').isUUID(),
  body('content').isString().isLength({ min: 1, max: 4000 }),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    if (overload.shouldRestrictNonEssentialWrites()) {
      return res.status(503).json({ error: 'Edits temporarily unavailable under high load' });
    }
    try {
      const target = await loadMessageTarget(req.params.id);
      if (!target || target.author_id !== req.user.id) {
        return res.status(404).json({ error: 'Message not found or not yours' });
      }

      const hasAccess = await ensureMessageAccess({
        channelId: target.channel_id,
        conversationId: target.conversation_id,
      }, req.user.id);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { rows } = await query(
        `UPDATE messages
         SET content=$1, edited_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND author_id=$3 AND deleted_at IS NULL
         RETURNING *`,
        [req.body.content, req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Message not found or not yours' });

      const baseMessage = rows[0];
      const message = await loadHydratedMessageById(baseMessage.id);
      if (baseMessage.channel_id) {
        redis.del(channelMsgCacheKey(baseMessage.channel_id)).catch(() => {});
      }
      sideEffects.indexMessage(baseMessage);
      if (baseMessage.conversation_id) {
        await publishConversationEvent(baseMessage.conversation_id, 'message:updated', message || baseMessage);
      } else {
        const key = targetKey(baseMessage.channel_id, baseMessage.conversation_id);
        sideEffects.publishMessageEvent(key, 'message:updated', message || baseMessage);
      }

      res.json({ message: message || baseMessage });
    } catch (err) { next(err); }
  }
);

// ── DELETE /messages/:id ───────────────────────────────────────────────────────
router.delete('/:id',
  param('id').isUUID(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    if (overload.shouldRestrictNonEssentialWrites()) {
      return res.status(503).json({ error: 'Deletes temporarily unavailable under high load' });
    }
    try {
      const target = await loadMessageTarget(req.params.id);
      if (!target || target.author_id !== req.user.id) {
        return res.status(404).json({ error: 'Message not found or not yours' });
      }

      const hasAccess = await ensureMessageAccess({
        channelId: target.channel_id,
        conversationId: target.conversation_id,
      }, req.user.id);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { rows } = await query(
        `DELETE FROM messages
         WHERE id=$1 AND author_id=$2
         RETURNING id, channel_id, conversation_id`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Message not found or not yours' });

      const message = rows[0];
      sideEffects.deleteMessage(message.id);
      // Keep the channel unread counter in sync: DECR mirrors the INCR done on create.
      if (message.channel_id) {
        redis.decr(`channel:msg_count:${message.channel_id}`).catch(() => {});
        redis.del(channelMsgCacheKey(message.channel_id)).catch(() => {});
      }
      if (message.conversation_id) {
        await publishConversationEvent(message.conversation_id, 'message:deleted', { id: message.id });
      } else {
        const key = targetKey(message.channel_id, message.conversation_id);
        sideEffects.publishMessageEvent(key, 'message:deleted', { id: message.id });
      }

      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

// ── PUT /messages/:id/read ─────────────────────────────────────────────────────
router.put('/:id/read',
  param('id').isUUID(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    if (overload.shouldRestrictNonEssentialWrites()) {
      return res.status(503).json({ error: 'Read receipts temporarily delayed under high load' });
    }
    try {
      const target = await loadMessageTarget(req.params.id);
      if (!target) return res.status(404).json({ error: 'Message not found' });

      const hasAccess = await ensureMessageAccess({
        channelId: target.channel_id,
        conversationId: target.conversation_id,
      }, req.user.id);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { channel_id, conversation_id } = target;
      const { rows: upsertRows } = await query(
        `INSERT INTO read_states (user_id, channel_id, conversation_id, last_read_message_id, last_read_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (user_id, COALESCE(channel_id, conversation_id))
         DO UPDATE SET last_read_message_id=$4, last_read_at=NOW()
         RETURNING last_read_at`,
        [req.user.id, channel_id, conversation_id, req.params.id]
      );

      const payload = {
        userId: req.user.id,
        channelId: channel_id,
        conversationId: conversation_id,
        lastReadMessageId: req.params.id,
        lastReadAt: upsertRows[0]?.last_read_at || new Date().toISOString(),
      };

      if (conversation_id) {
        await publishConversationEvent(conversation_id, 'read:updated', payload);
      } else {
        sideEffects.publishMessageEvent(targetKey(channel_id, conversation_id), 'read:updated', payload);
      }

      // Reset the user's unread watermark in Redis to the current channel message count
      if (channel_id) {
        try {
          const countKey = `channel:msg_count:${channel_id}`;
          const readKey  = `user:last_read_count:${channel_id}:${req.user.id}`;
          const currentCount = await redis.get(countKey);
          if (currentCount !== null) {
            await redis.set(readKey, currentCount);
          } else {
            // Channel counter not yet in Redis; initialize both
            const { rows: cntRows } = await query(
              `SELECT COUNT(*)::int AS cnt FROM messages WHERE channel_id = $1 AND deleted_at IS NULL`,
              [channel_id]
            );
            const total = cntRows[0]?.cnt ?? 0;
            const pipeline = redis.pipeline();
            pipeline.set(countKey, total, 'NX');
            pipeline.set(readKey, total);
            await pipeline.exec();
          }
        } catch (err) {
          logger.warn({ err, channel_id }, 'Failed to reset user:last_read_count in Redis');
        }
      }

      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
