-- no-transaction
-- Migration 018: Drop message indexes with zero or negligible scan counts
--
-- Rationale (from pg_stat_user_indexes since last stats reset):
--   idx_messages_author_created           0 scans  — fully superseded by
--       idx_messages_channel_author_created and idx_messages_conversation_author_created
--       which lead with the equality predicate (channel_id / conversation_id) the
--       queries actually filter on.
--   idx_messages_conv                     5 scans  — superseded by
--       idx_messages_conv_created_at_replay (127 k scans) and
--       idx_messages_conversation_author_created (1 M scans).
--
-- Impact: every INSERT into messages writes to all live indexes. Dropping these
-- two dead indexes reduces per-INSERT write amplification and frees disk space
-- without affecting any query plan.
--
-- Uses DROP INDEX CONCURRENTLY so the operation does not acquire an
-- AccessExclusiveLock on messages and does not interrupt live traffic.
-- The migration runner's "-- no-transaction" pragma runs this file outside
-- BEGIN/COMMIT (see backend/scripts/run-migrations.cjs).

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_author_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_conv;
