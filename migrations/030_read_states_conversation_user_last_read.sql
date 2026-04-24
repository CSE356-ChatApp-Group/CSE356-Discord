-- no-transaction
-- Speeds GET /api/v1/conversations list: lateral "latest other read" must probe
-- read_states by conversation_id first (not via user-target index).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_read_states_conversation_user_last_read
  ON read_states (conversation_id, user_id, last_read_at DESC NULLS LAST)
  WHERE conversation_id IS NOT NULL;
