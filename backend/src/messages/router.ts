/**
 * Messages router
 *
 * GET    /api/v1/messages?channelId=&before=&limit=   – paginated history
 * POST   /api/v1/messages                             – create
 * PATCH  /api/v1/messages/:id                         – edit
 * DELETE /api/v1/messages/:id                         – soft-delete
 * PUT    /api/v1/messages/:id/read                    – mark as read
 */

'use strict';

const express = require('express');
const { body, query: qv, param, validationResult } = require('express-validator');

const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const sideEffects      = require('./sideEffects');
const overload         = require('../utils/overload');

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
  const { rows } = await pool.query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId]
  );
  return rows.length > 0;
}

async function ensureChannelAccess(channelId, userId) {
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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
  [...new Set(targets)].forEach((target) => {
    sideEffects.publishMessageEvent(target, event, data);
  });
}

async function loadHydratedMessageById(messageId) {
  const { rows } = await pool.query(
    `SELECT m.*,
            row_to_json(u.*) AS author,
            COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
     FROM messages m
     JOIN users u ON u.id = m.author_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.id = $1
     GROUP BY m.id, u.id`,
    [messageId]
  );
  return rows[0] || null;
}

async function loadMessageTarget(messageId) {
  const { rows } = await pool.query(
    `SELECT id, author_id, channel_id, conversation_id
     FROM messages
     WHERE id = $1 AND deleted_at IS NULL`,
    [messageId]
  );
  return rows[0] || null;
}

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

      if (channelId) {
        const { rows: [channel] } = await pool.query(
          `SELECT c.id FROM channels c
            WHERE c.id = $1
              AND (c.is_private = FALSE 
                  OR EXISTS (
                    SELECT 1 FROM channel_members cm
                    WHERE cm.channel_id = c.id AND cm.user_id = $2
                  ))`,
          [channelId, req.user.id]
        );
        if (!channel) return res.status(403).json({ error: 'Access denied' });
      }
      
      if (conversationId) {
        const { rows: [conv] } = await pool.query(
          `SELECT 1 FROM conversation_participants 
            WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [conversationId, req.user.id]
        );
        if (!conv) return res.status(403).json({ error: 'Not a participant' });
      }
      const params = [limit];
      let where = channelId
        ? `m.channel_id = $${params.push(channelId)}`
        : `m.conversation_id = $${params.push(conversationId)}`;

      if (before) {
        where += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.push(before)})`;
      }

      const sql = `
        SELECT m.*,
               row_to_json(u.*) AS author,
               COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
        FROM   messages m
        JOIN   users u ON u.id = m.author_id
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE  ${where} AND m.deleted_at IS NULL
        GROUP  BY m.id, u.id
        ORDER  BY m.created_at DESC
        LIMIT  $1
      `;

      const { rows } = await pool.query(sql, params);
      res.json({ messages: rows.reverse() }); // return in chronological order
    } catch (err) { next(err); }
  }
);

// ── POST /messages ─────────────────────────────────────────────────────────────
router.post('/',
  body('content').optional().isString().isLength({ max: 4000 }),
  body('channelId').optional().isUUID(),
  body('conversationId').optional().isUUID(),
  body('threadId').optional().isUUID(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      const { content, channelId, conversationId, threadId } = req.body;

      if (!channelId && !conversationId) {
        return res.status(400).json({ error: 'channelId or conversationId required' });
      }
      if (!content) {
        return res.status(400).json({ error: 'content required (attach files in a separate request)' });
      }
      if (conversationId) {
        const isParticipant = await ensureActiveConversationParticipant(conversationId, req.user.id);
        if (!isParticipant) {
          return res.status(403).json({ error: 'Not a participant' });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO messages (channel_id, conversation_id, author_id, content, thread_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [channelId || null, conversationId || null, req.user.id, content, threadId || null]
      );
      const baseMessage = rows[0];
      const message = await loadHydratedMessageById(baseMessage.id);

      sideEffects.indexMessage(baseMessage);
      if (conversationId) {
        await publishConversationEvent(conversationId, 'message:created', message || baseMessage);
      } else {
        sideEffects.publishMessageEvent(targetKey(channelId, conversationId), 'message:created', message || baseMessage);
      }
      if (channelId) {
        const { rows: channelRows } = await pool.query(
          'SELECT community_id FROM channels WHERE id = $1',
          [channelId]
        );
        const communityId = channelRows[0]?.community_id;
        if (communityId) {
          sideEffects.publishMessageEvent(`community:${communityId}`, 'community:channel_message', {
            communityId,
            channelId,
            messageId: baseMessage.id,
            authorId: baseMessage.author_id,
            createdAt: baseMessage.created_at,
          });
        }
      }

      res.status(201).json({ message: message || baseMessage });
    } catch (err) { next(err); }
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

      const { rows } = await pool.query(
        `UPDATE messages
         SET content=$1, edited_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND author_id=$3 AND deleted_at IS NULL
         RETURNING *`,
        [req.body.content, req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Message not found or not yours' });

      const baseMessage = rows[0];
      const message = await loadHydratedMessageById(baseMessage.id);
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

      const { rows } = await pool.query(
        `UPDATE messages SET deleted_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL RETURNING *`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Message not found or not yours' });

      const message = rows[0];
      sideEffects.deleteMessage(message.id);
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
      const { rows: upsertRows } = await pool.query(
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

      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
