/**
 * DB helpers and SQL field lists for the conversations router.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONVERSATION_FIELDS =
  'c.id, c.name, c.created_by, c.created_at, c.updated_at, c.is_group, c.last_message_id, c.last_message_author_id, c.last_message_at';
const CONVERSATION_LIST_FIELDS =
  'c.id, c.name, c.created_by, c.created_at, c.updated_at, c.is_group, c.last_message_id, c.last_message_author_id, c.last_message_at';

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
    `SELECT ${CONVERSATION_FIELDS},
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

  const uuidValues = uniqueValues.filter((value) => UUID_RE.test(value));
  const textValues = uniqueValues.filter((value) => !UUID_RE.test(value));
  const byAny = new Map();

  if (uuidValues.length) {
    const { rows } = await client.query(
      `SELECT id::text AS id, username, email
       FROM users
       WHERE id = ANY($1::uuid[])`,
      [uuidValues]
    );

    rows.forEach((row) => {
      byAny.set(row.id, row.id);
      if (row.username) {
        byAny.set(row.username, row.id);
        byAny.set(row.username.toLowerCase(), row.id);
      }
      if (row.email) {
        byAny.set(row.email, row.id);
        byAny.set(row.email.toLowerCase(), row.id);
      }
    });
  }

  let unresolvedTextValues = textValues.filter(
    (value) => !byAny.has(value) && !byAny.has(value.toLowerCase())
  );

  if (unresolvedTextValues.length) {
    const { rows } = await client.query(
      `SELECT id::text AS id, username, email
       FROM users
       WHERE username = ANY($1::text[])
          OR email = ANY($1::text[])`,
      [unresolvedTextValues]
    );

    rows.forEach((row) => {
      if (row.username) {
        byAny.set(row.username, row.id);
        byAny.set(row.username.toLowerCase(), row.id);
      }
      if (row.email) {
        byAny.set(row.email, row.id);
        byAny.set(row.email.toLowerCase(), row.id);
      }
    });

    unresolvedTextValues = unresolvedTextValues.filter(
      (value) => !byAny.has(value) && !byAny.has(value.toLowerCase())
    );
  }

  if (unresolvedTextValues.length) {
    const unresolvedLowerValues = [...new Set(unresolvedTextValues.map((value) => value.toLowerCase()))];
    const { rows } = await client.query(
      `SELECT id::text AS id, username, email
       FROM users
       WHERE lower(username) = ANY($1::text[])
          OR lower(email) = ANY($1::text[])`,
      [unresolvedLowerValues]
    );

    rows.forEach((row) => {
      if (row.username) {
        byAny.set(row.username, row.id);
        byAny.set(row.username.toLowerCase(), row.id);
      }
      if (row.email) {
        byAny.set(row.email, row.id);
        byAny.set(row.email.toLowerCase(), row.id);
      }
    });
  }

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

module.exports = {
  CONVERSATION_FIELDS,
  CONVERSATION_LIST_FIELDS,
  getParticipantInputs,
  getActiveParticipantIds,
  requireActiveConversationParticipant,
  loadConversationWithParticipants,
  resolveParticipantIds,
  getUserDisplayName,
  getUserDisplayNamesMap,
  insertConversationParticipantsBatch,
  upsertConversationParticipantsBatch,
  createSystemMessage,
  createSystemMessagesBatch,
  isGroupConversation,
};
