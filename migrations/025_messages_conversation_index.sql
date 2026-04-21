-- no-transaction
-- Add a composite index on messages(conversation_id, created_at DESC) to support
-- DM history fetches. Without this every WHERE conversation_id = $1 query does a
-- full table scan (idx_messages_conv_created_at_replay only indexed created_at,
-- not conversation_id, so it was useless for this access pattern).
--
-- NOTE: must be a single statement in a -- no-transaction file so that pg.js
-- does not bundle it with other statements into one simple-query message
-- (PostgreSQL wraps multi-statement simple queries in an implicit transaction
-- which blocks CREATE INDEX CONCURRENTLY).
-- The old idx_messages_conv_created_at_replay is dropped in migration 026.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at DESC)
  INCLUDE (id, author_id)
  WHERE deleted_at IS NULL;
