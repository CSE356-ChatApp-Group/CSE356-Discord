-- Denormalized last message pointer on channels (avoids per-channel LATERAL
-- lookups in GET /communities and GET /channels under load).
-- Kept in sync on channel message create/delete; backfilled for existing rows.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS last_message_id UUID REFERENCES messages (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_message_author_id UUID REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_channels_last_message_at
  ON channels (last_message_at DESC NULLS LAST)
  WHERE last_message_id IS NOT NULL;

-- One-time backfill from current message history (best-effort).
UPDATE channels ch
SET
  last_message_id = lm.id,
  last_message_author_id = lm.author_id,
  last_message_at = lm.created_at
FROM (
  SELECT DISTINCT ON (channel_id)
    channel_id,
    id,
    author_id,
    created_at
  FROM messages
  WHERE channel_id IS NOT NULL
    AND deleted_at IS NULL
  ORDER BY channel_id, created_at DESC
) AS lm
WHERE ch.id = lm.channel_id
  AND (
    ch.last_message_id IS NULL
    OR ch.last_message_at IS DISTINCT FROM lm.created_at
  );
