/**
 * Conversations router (direct messages)
 *
 * GET  /api/v1/conversations          – list user's conversations
 * POST /api/v1/conversations          – create/get 1:1 or group DM
 * GET  /api/v1/conversations/:id      – get single conversation
 */

'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const fanout           = require('../websocket/fanout');

const router = express.Router();
router.use(authenticate);

function publishConversationEvents(targets, event, data) {
  const uniqueTargets = [...new Set(targets.filter(Boolean))];
  return Promise.allSettled(uniqueTargets.map((target) => fanout.publish(target, { event, data })));
}

function getParticipantInputs(body: Record<string, any> = {}) {
  const list = body.participantIds || body.participants;
  if (Array.isArray(list)) return list;

  return [body.participantId, body.userId].filter(Boolean);
}

async function getActiveParticipantIds(client, conversationId) {
  const { rows } = await client.query(
    `SELECT user_id::text AS user_id
     FROM conversation_participants
     WHERE conversation_id = $1 AND left_at IS NULL`,
    [conversationId]
  );
  return rows.map((row) => row.user_id);
}

async function requireActiveConversationParticipant(client, conversationId, userId) {
  const { rows } = await client.query(
    `SELECT c.id
     FROM conversations c
     JOIN conversation_participants cp
       ON cp.conversation_id = c.id
      AND cp.user_id = $2
      AND cp.left_at IS NULL
     WHERE c.id = $1`,
    [conversationId, userId]
  );

  return rows.length > 0;
}

async function loadConversationWithParticipants(client, conversationId) {
  const { rows } = await client.query(
    `SELECT c.*,
            json_agg(
              json_build_object(
                'id', u.id,
                'username', u.username,
                'displayName', u.display_name,
                'avatarUrl', u.avatar_url,
                'email', u.email
              )
              ORDER BY u.username
            ) AS participants
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id
     JOIN users u ON u.id = cp.user_id
     WHERE c.id = $1
     GROUP BY c.id`,
    [conversationId]
  );
  return rows[0] || null;
}

async function resolveParticipantIds(client, rawParticipants) {
  const raw = Array.isArray(rawParticipants) ? rawParticipants : [];
  const uniqueValues = [...new Set(raw.map(v => (v || '').toString().trim()).filter(Boolean))];
  if (!uniqueValues.length) return [];

  const { rows } = await client.query(
    `SELECT id::text, username, email
     FROM users
     WHERE id::text = ANY($1::text[])
        OR username = ANY($1::text[])
        OR email = ANY($1::text[])
        OR lower(username) = ANY($2::text[])
        OR lower(email) = ANY($2::text[])`,
    [uniqueValues, uniqueValues.map(v => v.toLowerCase())]
  );

  const byAny = new Map();
  rows.forEach((row) => {
    byAny.set(row.id, row.id);
    byAny.set(row.username, row.id);
    byAny.set(row.email, row.id);
    byAny.set(row.username.toLowerCase(), row.id);
    byAny.set(row.email.toLowerCase(), row.id);
  });

  const resolved = [];
  for (const value of uniqueValues) {
    const resolvedId = byAny.get(value) || byAny.get(value.toLowerCase());
    if (!resolvedId) {
      return null;
    }
    resolved.push(resolvedId);
  }

  return [...new Set(resolved)];
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              lm.id AS last_message_id,
              lm.author_id AS last_message_author_id,
              lm.created_at AS last_message_at,
              my_rs.last_read_message_id AS my_last_read_message_id,
              my_rs.last_read_at AS my_last_read_at,
              (array_agg(other_rs.last_read_message_id ORDER BY other_rs.last_read_at DESC NULLS LAST)
                FILTER (WHERE other_rs.user_id IS NOT NULL))[1] AS other_last_read_message_id,
              MAX(other_rs.last_read_at) AS other_last_read_at,
              json_agg(json_build_object('id',u.id,'username',u.username,'displayName',u.display_name,'avatarUrl',u.avatar_url))
                AS participants
       FROM   conversations c
       JOIN   conversation_participants cp ON cp.conversation_id = c.id
                                           AND cp.user_id = $1
                                           AND cp.left_at IS NULL
       JOIN   conversation_participants cp2 ON cp2.conversation_id = c.id
                                            AND cp2.left_at IS NULL
       JOIN   users u ON u.id = cp2.user_id
       LEFT JOIN LATERAL (
         SELECT m.id, m.author_id, m.created_at
         FROM messages m
         WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON TRUE
       LEFT JOIN read_states my_rs
              ON my_rs.conversation_id = c.id
             AND my_rs.user_id = $1
       LEFT JOIN read_states other_rs
              ON other_rs.conversation_id = c.id
             AND other_rs.user_id = cp2.user_id
             AND cp2.user_id <> $1
       GROUP  BY c.id, lm.id, lm.author_id, lm.created_at, my_rs.last_read_message_id, my_rs.last_read_at
       ORDER  BY COALESCE(lm.created_at, c.updated_at) DESC`,
      [req.user.id]
    );
    res.json({ conversations: rows });
  } catch (err) { next(err); }
});

// ── Create or get existing 1:1 ─────────────────────────────────────────────────
router.post('/',
  body('participantIds').optional().isArray({ min: 1, max: 9 }),
  body('participants').optional().isArray({ min: 1, max: 9 }),
  body('name').optional().isLength({ max: 100 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const providedParticipants = req.body.participantIds || req.body.participants || [];
      const resolvedParticipants = await resolveParticipantIds(client, providedParticipants);
      if (!resolvedParticipants) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or more participants were not found' });
      }

      const allIds = [...new Set([req.user.id, ...resolvedParticipants])];
      if (allIds.length < 2) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'At least one other participant is required' });
      }

      const isGroup = allIds.length > 2;

      // For 1:1, check if conversation already exists
      if (!isGroup) {
        const otherId = allIds.find(id => id !== req.user.id);
        const { rows } = await client.query(
          `SELECT c.* FROM conversations c
           JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
           JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
           WHERE c.name IS NULL
             AND cp1.left_at IS NULL
             AND cp2.left_at IS NULL
           LIMIT 1`,
          [req.user.id, otherId]
        );
        if (rows.length) {
          const existing = await loadConversationWithParticipants(client, rows[0].id);
          await client.query('COMMIT');
          return res.json({ conversation: existing || rows[0], created: false });
        }
      }

      const { rows: [conv] } = await client.query(
        `INSERT INTO conversations (name, created_by) VALUES ($1,$2) RETURNING *`,
        [req.body.name || null, req.user.id]
      );

      for (const uid of allIds) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2)`,
          [conv.id, uid]
        );
      }

      const conversation = await loadConversationWithParticipants(client, conv.id);
      const invitedUserIds = allIds.filter(id => id !== req.user.id);
      await client.query('COMMIT');

      if (conversation) {
        await publishConversationEvents(
          invitedUserIds.map((userId) => `user:${userId}`),
          'conversation:invited',
          {
            conversation,
            conversationId: conversation.id,
            invitedBy: req.user.id,
            participantIds: invitedUserIds,
          }
        );
      }

      res.status(201).json({ conversation: conversation || conv, created: true });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally { client.release(); }
  }
);

// ── Get single ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              json_agg(json_build_object('id',u.id,'username',u.username,'displayName',u.display_name))
                AS participants
       FROM conversations c
       JOIN conversation_participants me ON me.conversation_id = c.id
                                        AND me.user_id = $2
                                        AND me.left_at IS NULL
       JOIN conversation_participants cp ON cp.conversation_id = c.id
                                        AND cp.left_at IS NULL
       JOIN users u ON u.id = cp.user_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ conversation: rows[0] });
  } catch (err) { next(err); }
});
router.post('/:id/participants',
   param('id').isUUID(),
   body('participantIds').isArray({ min: 1 }).custom(arr => arr.every(x => typeof x === 'string')),
   async (req, res, next) => {
     const errors = validationResult(req);
     if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
 
     const client = await pool.connect();
     try {
       await client.query('BEGIN');
 
       const { rows: [isParticipant] } = await client.query(
         `SELECT 1 FROM conversation_participants 
          WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL`,
         [req.params.id, req.user.id]
       );
       if (!isParticipant) {
         await client.query('ROLLBACK');
         return res.status(403).json({ error: 'Not a participant in this conversation' });
       }
 
       const newParticipants = await resolveParticipantIds(client, req.body.participantIds);
       if (!newParticipants || newParticipants.length === 0) {
         await client.query('ROLLBACK');
         return res.status(400).json({ error: 'One or more participants not found' });
       }
 
       for (const uid of newParticipants) {
         if (uid === req.user.id) continue;
         await client.query(
           `INSERT INTO conversation_participants (conversation_id, user_id, left_at)
            VALUES ($1,$2,NULL)
            ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
           [req.params.id, uid]
         );
       }
 
       const conversation = await loadConversationWithParticipants(client, req.params.id);
       await client.query('COMMIT');
       res.json({ conversation });
     } catch (err) {
       await client.query('ROLLBACK');
       next(err);
     } finally { client.release(); }
   }
 );
 
 router.post('/:id/leave',
   param('id').isUUID(),
   async (req, res, next) => {
     const errors = validationResult(req);
     if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
 
     try {
       await pool.query(
         `UPDATE conversation_participants 
          SET left_at = NOW() 
          WHERE conversation_id = $1 AND user_id = $2`,
         [req.params.id, req.user.id]
       );
 
       const { rows } = await pool.query(
         `SELECT COUNT(*)::int as remaining FROM conversation_participants 
          WHERE conversation_id = $1 AND left_at IS NULL`,
         [req.params.id]
       );
 
       if (parseInt(rows[0].remaining, 10) === 0) {
         await pool.query('DELETE FROM conversations WHERE id = $1', [req.params.id]);
       }
 
       res.json({ success: true });
     } catch (err) { next(err); }
   }
 );

const addParticipantsValidators = [
  param('id').isUUID(),
  body('participantIds').optional().isArray({ min: 1, max: 9 }),
  body('participants').optional().isArray({ min: 1, max: 9 }),
  body('participantId').optional().isString().isLength({ min: 1, max: 255 }),
  body('userId').optional().isString().isLength({ min: 1, max: 255 }),
];

async function addParticipantsHandler(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const providedParticipants = getParticipantInputs(req.body);
  if (!providedParticipants.length) {
    return res.status(400).json({ error: 'participantIds, participants, participantId, or userId is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const conversationExists = await client.query(
      'SELECT id FROM conversations WHERE id = $1',
      [req.params.id]
    );
    if (!conversationExists.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const isParticipant = await requireActiveConversationParticipant(client, req.params.id, req.user.id);
    if (!isParticipant) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not a participant' });
    }

    const resolvedParticipants = await resolveParticipantIds(client, providedParticipants);
    if (!resolvedParticipants) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One or more participants were not found' });
    }

    const currentParticipantIds = await getActiveParticipantIds(client, req.params.id);
    const currentParticipantSet = new Set(currentParticipantIds);
    const participantIdsToAdd = resolvedParticipants.filter(
      (participantId) => participantId !== req.user.id && !currentParticipantSet.has(participantId)
    );

    for (const participantId of participantIdsToAdd) {
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET left_at = NULL, joined_at = NOW()`,
        [req.params.id, participantId]
      );
    }

    const conversation = await loadConversationWithParticipants(client, req.params.id);
    const activeParticipantIds = await getActiveParticipantIds(client, req.params.id);
    await client.query('COMMIT');

    const sharedEventData = {
      conversation,
      conversationId: req.params.id,
      participantIds: participantIdsToAdd,
      invitedBy: req.user.id,
    };

    await publishConversationEvents(
      [`conversation:${req.params.id}`, ...activeParticipantIds.map((participantId) => `user:${participantId}`)],
      'conversation:participant_added',
      sharedEventData
    );

    if (participantIdsToAdd.length) {
      await publishConversationEvents(
        participantIdsToAdd.map((participantId) => `user:${participantId}`),
        'conversation:invited',
        sharedEventData
      );
    }

    res.json({ conversation, addedParticipantIds: participantIdsToAdd });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

router.post('/:id/participants', ...addParticipantsValidators, addParticipantsHandler);
router.post('/:id/invite', ...addParticipantsValidators, addParticipantsHandler);

router.post('/:id/leave', param('id').isUUID(), async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const membership = await client.query(
      `SELECT 1
       FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [req.params.id, req.user.id]
    );
    if (!membership.rows.length) {
      const existingConversation = await client.query('SELECT 1 FROM conversations WHERE id = $1', [req.params.id]);
      await client.query('ROLLBACK');
      return res.status(existingConversation.rows.length ? 403 : 404).json({
        error: existingConversation.rows.length ? 'Not a participant' : 'Conversation not found',
      });
    }

    await client.query(
      `UPDATE conversation_participants
       SET left_at = NOW()
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [req.params.id, req.user.id]
    );

    const activeParticipantIds = await getActiveParticipantIds(client, req.params.id);
    await client.query('COMMIT');

    await publishConversationEvents(
      [`conversation:${req.params.id}`, `user:${req.user.id}`, ...activeParticipantIds.map((participantId) => `user:${participantId}`)],
      'conversation:participant_left',
      {
        conversationId: req.params.id,
        userId: req.user.id,
        leftUserId: req.user.id,
      }
    );

    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
