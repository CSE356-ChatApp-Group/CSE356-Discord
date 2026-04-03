-- Additional indexes for growth-sensitive list and unread queries.
-- These keep community/conversation listing paths efficient as memberships and
-- read-state tables grow.

CREATE INDEX IF NOT EXISTS idx_read_states_user_channel
    ON read_states (user_id, channel_id)
    WHERE channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_read_states_user_conversation
    ON read_states (user_id, conversation_id)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_participants_active_user
    ON conversation_participants (user_id, conversation_id)
    WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_participants_active_conversation
    ON conversation_participants (conversation_id, user_id)
    WHERE left_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_channels_community_private_position
    ON channels (community_id, is_private, position, id);
