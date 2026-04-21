-- no-transaction
-- Add a proper composite index on messages(conversation_id, created_at DESC)
-- to support DM history fetches. Without this every WHERE conversation_id = $1
-- query does a full table scan (existing idx_messages_conv_created_at_replay
-- only indexes created_at, not conversation_id, so it is useless for this access
-- pattern).
--
-- DROP the partial-only replay index too since the new composite index subsumes
-- it (the new index is already partial: WHERE deleted_at IS NULL).
-- NOTE: use plain DROP INDEX IF EXISTS (never CONCURRENTLY in this file, that
-- only applies to CREATE; DROP CONCURRENTLY is always forbidden in migrations).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at DESC)
  INCLUDE (id, author_id)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_messages_conv_created_at_replay;
