-- Speeds communities unread-count hydration by narrowing channel scans
-- to active channels in the target communities.
CREATE INDEX IF NOT EXISTS idx_channels_unread_lookup
  ON channels (community_id, id)
  WHERE last_message_id IS NOT NULL;
