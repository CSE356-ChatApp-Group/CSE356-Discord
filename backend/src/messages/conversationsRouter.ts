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
const { query, getClient } = require('../db/pool');
const redis            = require('../db/redis');
const { authenticate } = require('../middleware/authenticate');
const fanout           = require('../websocket/fanout');
const presenceService  = require('../presence/service');
const { invalidateWsBootstrapCache } = require('../websocket/server');
const { bustConversationMessagesCache } = require('./messageCacheBust');
const { wrapFanoutPayload } = require('./realtimePayload');
const { recordEndpointListCache } = require('../utils/endpointCacheMetrics');

const router = express.Router();
router.use(authenticate);

function publishConversationEvents(targets, event, data) {
  const uniqueTargets = [...new Set(targets.filter(Boolean))];
  const payload = wrapFanoutPayload(event, data);
  return Promise.allSettled(uniqueTargets.map((target) => fanout.publish(target, payload)));
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
    byAny.set(row.username.toLowerCase(), row.id);
    if (row.email) {
      byAny.set(row.email, row.id);
      byAny.set(row.email.toLowerCase(), row.id);
    }
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

/** One round-trip for display names (group invite system messages). */
async function getUserDisplayNamesMap(client, userIds: string[]) {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const { rows } = await client.query(
    `SELECT id::text AS id, display_name FROM users WHERE id = ANY($1::uuid[])`,
    [userIds]
  );
  for (const row of rows) {
    map.set(row.id, row.display_name?.trim() ? row.display_name : 'User');
  }
  for (const id of userIds) {
    if (!map.has(id)) map.set(id, 'User');
  }
  return map;
}

async function insertConversationParticipantsBatch(client, conversationId: string, userIds: string[]) {
  if (!userIds.length) return;
  await client.query(
    `INSERT INTO conversation_participants (conversation_id, user_id)
     SELECT $1::uuid, uid
     FROM unnest($2::uuid[]) AS uid`,
    [conversationId, userIds]
  );
}

async function upsertConversationParticipantsBatch(client, conversationId: string, userIds: string[]) {
  if (!userIds.length) return;
  await client.query(
    `INSERT INTO conversation_participants (conversation_id, user_id, joined_at, left_at)
     SELECT $1::uuid, uid, NOW(), NULL
     FROM unnest($2::uuid[]) AS uid
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET left_at = NULL, joined_at = NOW()`,
    [conversationId, userIds]
  );
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

/** One INSERT … SELECT unnest for multiple “X joined the group.” lines. */
async function createSystemMessagesBatch(client, conversationId: string, contents: string[]) {
  if (!contents.length) return [];
  const { rows } = await client.query(
    `INSERT INTO messages (conversation_id, author_id, content, type)
     SELECT $1::uuid, NULL, c, 'system'::message_type
     FROM unnest($2::text[]) AS c
     RETURNING id, conversation_id, author_id, content, type, created_at, updated_at, deleted_at, edited_at, channel_id, thread_id`,
    [conversationId, contents]
  );
  return rows;
}

async function isGroupConversation(client, conversationId) {
  const { rows } = await client.query(
    `SELECT is_group FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (!rows[0]) return false;
  return Boolean(rows[0].is_group);
}

const CONVERSATIONS_CACHE_TTL_SECS = 15;
function conversationsCacheKey(userId) { return `conversations:list:${userId}`; }

// In-process singleflight: prevents thundering-herd on cache expiry.
const conversationsInflight: Map<string, Promise<{ conversations: any[] }>> = new Map();

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const cacheKey = conversationsCacheKey(req.user.id);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      recordEndpointListCache('conversations', 'hit');
      return res.json(JSON.parse(cached));
    }
  } catch {
    // cache miss – fall through to DB
  }

  if (conversationsInflight.has(cacheKey)) {
    recordEndpointListCache('conversations', 'coalesced');
    try {
      return res.json(await conversationsInflight.get(cacheKey));
    } catch (err) {
      return next(err);
    }
  }

  recordEndpointListCache('conversations', 'miss');
  const promise: Promise<{ conversations: any[] }> = (async () => {
    const { rows } = await query(
      `SELECT c.*,
              COALESCE(m_denorm.id, lm.id) AS last_message_id,
              COALESCE(m_denorm.author_id, lm.author_id) AS last_message_author_id,
              COALESCE(m_denorm.created_at, lm.created_at) AS last_message_at,
              my_rs.last_read_message_id AS my_last_read_message_id,
              my_rs.last_read_at AS my_last_read_at,
              latest_other_rs.last_read_message_id AS other_last_read_message_id,
              latest_other_rs.last_read_at AS other_last_read_at,
              json_agg(json_build_object('id',u.id,'username',u.username,'displayName',u.display_name,'avatarUrl',u.avatar_url))
                AS participants
       FROM   conversations c
       JOIN   conversation_participants cp ON cp.conversation_id = c.id
                                           AND cp.user_id = $1
                                           AND cp.left_at IS NULL
       JOIN   conversation_participants cp2 ON cp2.conversation_id = c.id
                                            AND cp2.left_at IS NULL
       JOIN   users u ON u.id = cp2.user_id
       LEFT JOIN messages m_denorm
         ON m_denorm.id = c.last_message_id
        AND m_denorm.conversation_id = c.id
        AND m_denorm.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT m.id, m.author_id, m.created_at
         FROM messages m
         WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC
         LIMIT 1
       ) lm ON m_denorm.id IS NULL
       LEFT JOIN read_states my_rs
              ON my_rs.conversation_id = c.id
             AND my_rs.user_id = $1
       LEFT JOIN LATERAL (
         SELECT rs.last_read_message_id, rs.last_read_at
         FROM read_states rs
         JOIN conversation_participants cp_other
           ON cp_other.conversation_id = c.id
          AND cp_other.user_id = rs.user_id
          AND cp_other.left_at IS NULL
         WHERE rs.conversation_id = c.id
           AND rs.user_id <> $1
         ORDER BY rs.last_read_at DESC NULLS LAST
         LIMIT 1
       ) latest_other_rs ON TRUE
       GROUP  BY c.id, m_denorm.id, m_denorm.author_id, m_denorm.created_at,
                 lm.id, lm.author_id, lm.created_at, my_rs.last_read_message_id, my_rs.last_read_at,
                 latest_other_rs.last_read_message_id, latest_other_rs.last_read_at
      HAVING c.is_group = TRUE OR COUNT(cp2.user_id) > 1
       ORDER  BY COALESCE(m_denorm.created_at, lm.created_at, c.updated_at) DESC`,
      [req.user.id]
    );
    const payload = { conversations: rows };
    redis.setex(cacheKey, CONVERSATIONS_CACHE_TTL_SECS, JSON.stringify(payload)).catch(() => {});
    return payload;
  })();

  conversationsInflight.set(cacheKey, promise);
  promise.finally(() => conversationsInflight.delete(cacheKey));

  try {
    res.json(await promise);
  } catch (err) { next(err); }
});

// ── Create or get existing 1:1 ─────────────────────────────────────────────────
router.post('/',
  body('participantIds').optional().isArray({ min: 1 }),
  body('participants').optional().isArray({ min: 1 }),
  body('name').optional().isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let client;
    try {
      client = await getClient();
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

      await insertConversationParticipantsBatch(client, conv.id, allIds);

      const conversation = await loadConversationWithParticipants(client, conv.id);
      const invitedUserIds = allIds.filter(id => id !== req.user.id);
      await client.query('COMMIT');
      await Promise.allSettled([
        ...allIds.map((participantId) => presenceService.invalidatePresenceFanoutTargets(participantId)),
        ...allIds.map((participantId) => invalidateWsBootstrapCache(participantId)),
        ...allIds.map((uid) => redis.del(conversationsCacheKey(uid))),
      ]);

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
      await client?.query('ROLLBACK');
      next(err);
    } finally { client?.release(); }
  }
);

// ── Get single ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
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
// ── Rename group DM ────────────────────────────────────────────────────────────
router.patch(
  '/:id',
  authenticate,
  param('id').isUUID(),
  body('name').optional({ nullable: true }).isString(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { id } = req.params;
      const userId = req.user.id;

      const client = await getClient();
      try {
        const { rows } = await client.query(
          `SELECT c.is_group
             FROM conversations c
             JOIN conversation_participants cp ON cp.conversation_id = c.id
            WHERE c.id = $1 AND cp.user_id = $2 AND cp.left_at IS NULL`,
          [id, userId]
        );

        if (rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
        if (!rows[0].is_group) return res.status(403).json({ error: 'Cannot rename a 1-to-1 DM' });

        const name = req.body.name != null ? req.body.name : null;
        await client.query(
          `UPDATE conversations SET name = $1, updated_at = NOW() WHERE id = $2`,
          [name || null, id]
        );

        const conv = await loadConversationWithParticipants(client, id);
        const participantIds: string[] = Array.isArray(conv?.participants)
          ? conv.participants.map((p: { id: string }) => p.id)
          : [];

        await Promise.allSettled([
          publishConversationEvents(
            [`conversation:${id}`],
            'conversation:updated',
            { conversation: conv, conversationId: id }
          ),
          ...participantIds.map((uid) => redis.del(conversationsCacheKey(uid))),
        ]);
        res.json({ conversation: conv });
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  }
);

const addParticipantsValidators = [
  param('id').isUUID(),
  body('participantIds').optional().isArray({ min: 1 }),
  body('participants').optional().isArray({ min: 1 }),
  body('participantId').optional().isString(),
  body('userId').optional().isString(),
];

async function addParticipantsHandler(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const providedParticipants = getParticipantInputs(req.body);
  if (!providedParticipants.length) {
    return res.status(400).json({ error: 'participantIds, participants, participantId, or userId is required' });
  }

  let client;
  try {
    client = await getClient();
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

    const { rows: [convMeta] } = await client.query(
      'SELECT is_group FROM conversations WHERE id = $1',
      [req.params.id]
    );

    if (!convMeta.is_group && participantIdsToAdd.length > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot invite users to a 1-to-1 DM' });
    }

    await upsertConversationParticipantsBatch(client, req.params.id, participantIdsToAdd);

    let joinedGroupMessages = [];
    if (convMeta.is_group && participantIdsToAdd.length > 0) {
      const nameMap = await getUserDisplayNamesMap(client, participantIdsToAdd);
      const contents = participantIdsToAdd.map(
        (pid) => `${nameMap.get(pid) || 'User'} joined the group.`,
      );
      joinedGroupMessages = await createSystemMessagesBatch(client, req.params.id, contents);
    }

    const conversation = await loadConversationWithParticipants(client, req.params.id);
    const activeParticipantIds = participantIdsToAdd.length > 0
      ? await getActiveParticipantIds(client, req.params.id)
      : currentParticipantIds;

    await client.query('COMMIT');
    if (participantIdsToAdd.length > 0) {
      await Promise.allSettled([
        ...participantIdsToAdd.map((participantId) =>
          presenceService.invalidatePresenceFanoutTargets(participantId)
        ),
        ...participantIdsToAdd.map((participantId) =>
          invalidateWsBootstrapCache(participantId)
        ),
        // Invalidate conversation list cache for newly added AND existing
        // participants so everyone sees the updated participant list immediately.
        ...[...participantIdsToAdd, ...currentParticipantIds].map((uid) =>
          redis.del(conversationsCacheKey(uid))
        ),
      ]);
    }

    if (joinedGroupMessages.length > 0) {
      // System messages bypass POST /messages and its cache bust; await DEL so a tight
      // invite→GET poll cannot read stale first-page JSON (same guarantee as POST /messages).
      try {
        await bustConversationMessagesCache(redis, req.params.id);
      } catch {
        /* non-fatal: TTL backstop if Redis errors */
      }
      const targets = [
        `conversation:${req.params.id}`,
        ...activeParticipantIds.map((uid) => `user:${uid}`),
      ];
      for (const joinedGroupMessage of joinedGroupMessages) {
        await publishConversationEvents(targets, 'message:created', {
          ...joinedGroupMessage,
          author: null,
          attachments: [],
        });
      }
    }

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
    await client?.query('ROLLBACK');
    next(err);
  } finally {
    client?.release();
  }
}

router.post('/:id/participants', ...addParticipantsValidators, addParticipantsHandler);
router.post('/:id/invite', ...addParticipantsValidators, addParticipantsHandler);

router.post('/:id/leave', param('id').isUUID(), async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  let client;
  try {
    client = await getClient();
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

    const isGroup = await isGroupConversation(client, req.params.id);
    if (!isGroup) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Cannot leave a 1-to-1 DM' });
    }

    await client.query(
      `UPDATE conversation_participants
       SET left_at = NOW()
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [req.params.id, req.user.id]
    );

    const activeParticipantIds = await getActiveParticipantIds(client, req.params.id);
    // Delete only when the final active participant leaves.
    const shouldDelete = activeParticipantIds.length === 0;

    // Emit system message for surviving group DMs.
    let leftGroupMessage = null;
    if (!shouldDelete) {
      const leftUserName = await getUserDisplayName(client, req.user.id);
      leftGroupMessage = await createSystemMessage(client, req.params.id, `${leftUserName} left the group.`);
    }

    if (shouldDelete) {
      await client.query('DELETE FROM conversations WHERE id = $1', [req.params.id]);
    }
    await client.query('COMMIT');
    await Promise.allSettled([
      presenceService.invalidatePresenceFanoutTargets(req.user.id),
      invalidateWsBootstrapCache(req.user.id),
    ]);
    // DM latest-page cache: leave adds a system row or deletes the thread; POST /messages is not used.
    try {
      await bustConversationMessagesCache(redis, req.params.id);
    } catch {
      /* non-fatal */
    }
    try {
      await redis.del(conversationsCacheKey(req.user.id));
    } catch {
      /* non-fatal */
    }
    if (!shouldDelete && activeParticipantIds.length > 0) {
      await Promise.allSettled(
        activeParticipantIds.map((uid) => redis.del(conversationsCacheKey(uid))),
      );
    }

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
    await client?.query('ROLLBACK');
    next(err);
  } finally {
    client?.release();
  }
});

module.exports = router;
