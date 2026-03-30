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

async function publishConversationInviteNotifications(targets, data) {
  // Emit compatibility aliases because different clients/tests may listen for
  // either invited/invite/created when a user is added to a DM conversation.
  const inviteEvents = ['conversation:invited', 'conversation:invite', 'conversation:created'];
  await Promise.allSettled(
    inviteEvents.map((event) => publishConversationEvents(targets, event, data))
  );
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
     JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.left_at IS NULL
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

async function getUserDisplayName(client, userId) {
  const { rows } = await client.query(
    `SELECT display_name FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0]?.display_name || 'User';
}

async function createSystemMessage(client, conversationId, content) {
  const { rows } = await client.query(
    `INSERT INTO messages (conversation_id, author_id, content, type)
     VALUES ($1, NULL, $2, 'system')
         RETURNING id, conversation_id, author_id, content, type, created_at, updated_at, deleted_at, edited_at, channel_id, thread_id`,
    [conversationId, content]
  );
  return rows[0] || null;
}

async function isGroupConversation(client, conversationId) {
  const { rows } = await client.query(
    `SELECT is_group FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (!rows[0]) return false;
  return Boolean(rows[0].is_group);
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
      HAVING COUNT(cp2.user_id) > 1
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
             AND c.is_group = FALSE
             AND cp1.left_at IS NULL
             AND cp2.left_at IS NULL
             AND (SELECT COUNT(*) FROM conversation_participants
                  WHERE conversation_id = c.id AND left_at IS NULL) = 2
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
        `INSERT INTO conversations (name, created_by, is_group) VALUES ($1, $2, $3) RETURNING *`,
        [req.body.name || null, req.user.id, isGroup]
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
        await publishConversationInviteNotifications(
          invitedUserIds.map((userId) => `user:${userId}`),
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

    // Bug 3: inviting into a 1:1 DM creates a NEW group conversation instead of
    // mutating the private conversation. The original 1:1 is left untouched.
    const { rows: [convMeta] } = await client.query(
      'SELECT is_group FROM conversations WHERE id = $1',
      [req.params.id]
    );

    if (!convMeta.is_group && participantIdsToAdd.length > 0) {
      const allNewIds = [...new Set([...currentParticipantIds, ...participantIdsToAdd])];

      const { rows: [newConv] } = await client.query(
        `INSERT INTO conversations (name, created_by, is_group) VALUES (NULL, $1, TRUE) RETURNING *`,
        [req.user.id]
      );
      for (const uid of allNewIds) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)`,
          [newConv.id, uid]
        );
      }

      const newConversation = await loadConversationWithParticipants(client, newConv.id);
      await client.query('COMMIT');

      const sharedEventData = {
        conversation: newConversation,
        conversationId: newConv.id,
        participantIds: participantIdsToAdd,
        invitedBy: req.user.id,
      };
      await publishConversationEvents(
        allNewIds.map((uid) => `user:${uid}`),
        'conversation:participant_added',
        sharedEventData
      );
      await publishConversationInviteNotifications(
        participantIdsToAdd.map((uid) => `user:${uid}`),
        sharedEventData
      );

      return res.status(201).json({
        conversation: newConversation || newConv,
        addedParticipantIds: participantIdsToAdd,
        createdNewConversation: true,
      });
    }

    for (const participantId of participantIdsToAdd) {
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, joined_at, left_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (conversation_id, user_id)
         DO UPDATE SET left_at = NOW()`,
        [req.params.id, participantId]
      );
    }

    const conversation = await loadConversationWithParticipants(client, req.params.id);

    await client.query('COMMIT');

    const sharedEventData = {
      conversation,
      conversationId: req.params.id,
      participantIds: participantIdsToAdd,
      invitedBy: req.user.id,
    };

    if (participantIdsToAdd.length) {
      await publishConversationEvents(
        [`conversation:${req.params.id}`, ...currentParticipantIds.map((participantId) => `user:${participantId}`)],
        'conversation:participant_added',
        sharedEventData
      );
    }

    if (participantIdsToAdd.length) {
      await publishConversationInviteNotifications(
        participantIdsToAdd.map((participantId) => `user:${participantId}`),
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

router.post('/:id/accept', param('id').isUUID(), async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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

    const participation = await client.query(
      `SELECT left_at
       FROM conversation_participants
       WHERE conversation_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!participation.rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not invited' });
    }

    const wasPending = participation.rows[0].left_at !== null;

    if (wasPending) {
      await client.query(
        `UPDATE conversation_participants
         SET left_at = NULL, joined_at = NOW()
         WHERE conversation_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
    }

    const conversation = await loadConversationWithParticipants(client, req.params.id);
    const activeParticipantIds = wasPending
      ? await getActiveParticipantIds(client, req.params.id)
      : [];

    let joinedGroupMessage = null;
    const groupConversation = wasPending
      ? await isGroupConversation(client, req.params.id)
      : false;

    if (wasPending && groupConversation) {
      const joinedUserName = await getUserDisplayName(client, req.user.id);
      joinedGroupMessage = await createSystemMessage(client, req.params.id, `${joinedUserName} joined the group.`);
    }

    await client.query('COMMIT');

    if (wasPending && joinedGroupMessage) {
      const targets = [
        `conversation:${req.params.id}`,
        ...activeParticipantIds.map((uid) => `user:${uid}`),
      ];

      await publishConversationEvents(targets, 'message:created', {
        ...joinedGroupMessage,
        author: null,
        attachments: [],
      });
    }

    if (wasPending) {
      await publishConversationEvents(
        [`conversation:${req.params.id}`, ...activeParticipantIds.map((participantId) => `user:${participantId}`)],
        'conversation:participant_added',
        {
          conversation,
          conversationId: req.params.id,
          participantIds: [req.user.id],
          invitedBy: req.user.id,
        }
      );
    }

    res.json({ conversation, accepted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

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
    // If no participants remain, or only one remains, retire the DM to avoid stale self-only entries.
    let shouldDelete = activeParticipantIds.length <= 1;

    // Emit system message for leaving group DMs (2+ participants remain, or would have been 3+ before deletion)
    let leftGroupMessage = null;
    if (!shouldDelete && activeParticipantIds.length >= 2) {
      const leftUserName = await getUserDisplayName(client, req.user.id);
      leftGroupMessage = await createSystemMessage(client, req.params.id, `${leftUserName} left the group.`);
    }

    if (shouldDelete) {
      await client.query('DELETE FROM conversations WHERE id = $1', [req.params.id]);
    }
    await client.query('COMMIT');

    // Broadcast system message if group DM and not deleted
    if (leftGroupMessage) {
      const targets = [
        `conversation:${req.params.id}`,
        ...activeParticipantIds.map((uid) => `user:${uid}`),
        `user:${req.user.id}`,
      ];
      await publishConversationEvents(targets, 'message:created', {
        ...leftGroupMessage,
        author: null,
        attachments: [],
      });
    }

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
