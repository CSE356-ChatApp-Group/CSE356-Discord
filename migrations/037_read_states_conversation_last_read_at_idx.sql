-- Migration 037: Add index on read_states(conversation_id, last_read_at DESC)
--
-- The GET /conversations list query has a LATERAL subquery that for each
-- conversation sorts read_states by last_read_at DESC to find the most recent
-- other-participant read state. The existing idx_read_states_conversation_user
-- is on (conversation_id, user_id) and cannot satisfy the ORDER BY, forcing a
-- per-row sort step. This index makes the LATERAL fetch O(1) per conversation.

CREATE INDEX IF NOT EXISTS idx_read_states_conversation_last_read_at
  ON read_states (conversation_id, last_read_at DESC NULLS LAST)
  WHERE conversation_id IS NOT NULL;
