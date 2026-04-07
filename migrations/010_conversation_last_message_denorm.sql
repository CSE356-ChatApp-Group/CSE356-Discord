-- Denormalized last message on conversations (avoids per-row LATERAL on GET /conversations).
-- Synced on conversation message create/delete; backfilled for existing rows.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_id UUID REFERENCES messages (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_message_author_id UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON conversations (last_message_at DESC NULLS LAST)
  WHERE last_message_id IS NOT NULL;

UPDATE conversations conv
SET
  last_message_id = lm.id,
  last_message_author_id = lm.author_id,
  last_message_at = lm.created_at
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    id,
    author_id,
    created_at
  FROM messages
  WHERE conversation_id IS NOT NULL
    AND deleted_at IS NULL
  ORDER BY conversation_id, created_at DESC
) AS lm
WHERE conv.id = lm.conversation_id
  AND (
    conv.last_message_id IS NULL
    OR conv.last_message_at IS DISTINCT FROM lm.created_at
  );
