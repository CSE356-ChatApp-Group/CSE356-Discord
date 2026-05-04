-- no-transaction
-- Migration 039: Cross-channel recency index for scoped_recent_candidates CTE.
--
-- scoped_recent_candidates joins messages with a small set of channel IDs
-- (e.g. 12 channels) then sorts by (created_at DESC, id DESC) LIMIT 800.
-- The prior plan does a nested loop over each channel using
-- idx_messages_channel(channel_id, created_at DESC), fetching all rows per
-- channel (~15K avg) before the top-N heapsort — 187K rows touched total.
-- With a stale visibility map those become random heap fetches; even when
-- the visibility map is fresh this plan scans more rows than necessary.
--
-- This index lets the planner alternatively start from the most recent
-- messages globally and filter by channel_id, terminating as soon as 800
-- qualifying rows are found. For active communities (channels that dominate
-- recent traffic) this is O(800) rows read instead of O(all rows in community).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_created_at_channel
  ON messages (created_at DESC, channel_id)
  WHERE deleted_at IS NULL;
