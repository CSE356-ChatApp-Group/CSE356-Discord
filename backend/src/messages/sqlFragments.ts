export const MESSAGE_RETURNING_FIELDS = `
  id,
  channel_id,
  conversation_id,
  author_id,
  content,
  type,
  thread_id,
  edited_at,
  deleted_at,
  created_at,
  updated_at`;

export const MESSAGE_SELECT_FIELDS = `
  m.id,
  m.channel_id,
  m.conversation_id,
  m.author_id,
  m.content,
  m.type,
  m.thread_id,
  m.edited_at,
  m.deleted_at,
  m.created_at,
  m.updated_at`;

export const MESSAGE_AUTHOR_JSON = `
  CASE
    WHEN u.id IS NULL THEN NULL
    ELSE json_build_object(
      'id', u.id,
      'username', u.username,
      'email', u.email,
      'display_name', u.display_name,
      'avatar_url', u.avatar_url
    )
  END AS author`;

/**
 * Plain message columns only (no author subquery). Used for channel posts where the
 * Redis insert lock should cover minimal btree/GIN work; author + attachments are
 * loaded in a follow-up query after the lock is released.
 */
export const MESSAGE_INSERT_RETURNING_CORE = `
  m.id,
  m.channel_id,
  m.conversation_id,
  m.author_id,
  m.content,
  m.type,
  m.thread_id,
  m.edited_at,
  m.deleted_at,
  m.created_at,
  m.updated_at`;

/** Same access predicates as merged channel insert; only on insert miss. */
export const MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL = `
SELECT
  EXISTS(SELECT 1 FROM users WHERE id = $2) AS author_exists,
  EXISTS (
    SELECT 1
    FROM channels c
    JOIN communities co ON co.id = c.community_id
    WHERE c.id = $1
      AND (c.is_private = FALSE
           OR co.owner_id = $2
           OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
      AND (co.owner_id = $2
           OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2))
  ) AS has_access,
  (
    SELECT c.community_id
    FROM channels c
    JOIN communities co ON co.id = c.community_id
    WHERE c.id = $1
      AND (c.is_private = FALSE
           OR co.owner_id = $2
           OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
      AND (co.owner_id = $2
           OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2))
    LIMIT 1
  ) AS community_id`;

/**
 * Channel POST: one DB round-trip for access + row insert (no separate access SELECT on success).
 * Params: $1 channel_id, $2 author_id, $3 content, $4 thread_id.
 * On success, adds `post_insert_community_id` (strip before returning row to callers).
 */
export const MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL = `
INSERT INTO messages AS m (channel_id, author_id, content, thread_id)
SELECT
  c.id,
  $2::uuid,
  $3::text,
  CAST($4 AS uuid)
FROM channels c
JOIN communities co ON co.id = c.community_id
WHERE c.id = $1::uuid
  AND (
    c.is_private = FALSE
    OR co.owner_id = $2
    OR EXISTS (
      SELECT 1 FROM channel_members chm
      WHERE chm.channel_id = c.id AND chm.user_id = $2
    )
  )
  AND (co.owner_id = $2 OR EXISTS (
    SELECT 1 FROM community_members cm
    WHERE cm.community_id = c.community_id AND cm.user_id = $2
  ))
RETURNING
  ${MESSAGE_INSERT_RETURNING_CORE.trim()},
  (SELECT ch.community_id FROM channels ch WHERE ch.id = m.channel_id LIMIT 1) AS post_insert_community_id`;

/** Author JSON inside INSERT…RETURNING (avoids a second SELECT+JOIN in the same transaction). */
export const MESSAGE_INSERT_RETURNING_AUTHOR = `
  m.id,
  m.channel_id,
  m.conversation_id,
  m.author_id,
  m.content,
  m.type,
  m.thread_id,
  m.edited_at,
  m.deleted_at,
  m.created_at,
  m.updated_at,
  (
    SELECT CASE
      WHEN u.id IS NULL THEN NULL
      ELSE json_build_object(
        'id', u.id,
        'username', u.username,
        'email', u.email,
        'display_name', u.display_name,
        'avatar_url', u.avatar_url
      )
    END
    FROM users u
    WHERE u.id = m.author_id
  ) AS author`;
