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
