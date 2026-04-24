-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_created_desc
  ON messages (conversation_id, created_at DESC)
  WHERE deleted_at IS NULL;
