CREATE INDEX IF NOT EXISTS idx_messages_channel_author_created
    ON messages (channel_id, author_id, created_at DESC)
    WHERE deleted_at IS NULL AND channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_author_created
    ON messages (conversation_id, author_id, created_at DESC)
    WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_author_created
    ON messages (author_id, created_at DESC)
    WHERE deleted_at IS NULL AND author_id IS NOT NULL;
