-- Covering indexes for "latest message per channel/conversation" probes used in
-- GET /channels LATERAL and similar paths — avoids heap fetches under load.

DROP INDEX IF EXISTS idx_messages_channel;
CREATE INDEX idx_messages_channel ON messages (channel_id, created_at DESC)
  INCLUDE (id, author_id)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_messages_conv;
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at DESC)
  INCLUDE (id, author_id)
  WHERE deleted_at IS NULL;
