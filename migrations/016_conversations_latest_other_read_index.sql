-- Speeds GET /conversations, specifically the "latest other participant read
-- state" LATERAL lookup ordered by last_read_at DESC for each conversation.
-- This is a low-risk index-only improvement for the route that has shown
-- recurring p95 latency alerts in production.

CREATE INDEX IF NOT EXISTS idx_read_states_conversation_latest_read
  ON read_states (conversation_id, last_read_at DESC NULLS LAST)
  INCLUDE (user_id, last_read_message_id)
  WHERE conversation_id IS NOT NULL;
