-- Drop the old partial index on created_at that was superseded by
-- idx_messages_conversation (migration 025). The old index only indexed
-- created_at DESC with a WHERE conversation_id IS NOT NULL predicate and
-- was useless for WHERE conversation_id = $1 lookups.
-- This is a normal transaction migration (plain DROP INDEX IF EXISTS, no CONCURRENTLY).

DROP INDEX IF EXISTS idx_messages_conv_created_at_replay;
