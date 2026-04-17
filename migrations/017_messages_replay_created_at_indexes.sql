-- no-transaction
-- Migration 017: Indexes to accelerate reconnect-replay time-range scans
--
-- Context:
--   reconnectReplay.ts runs a CTE that filters messages by:
--     (channel_id IS NOT NULL OR conversation_id IS NOT NULL)
--     AND created_at BETWEEN $lower AND $upper
--     AND deleted_at IS NULL
--
--   The existing partial indexes lead with channel_id / conversation_id:
--     idx_messages_channel_author_created   (channel_id, author_id, created_at DESC)
--     idx_messages_conversation_author_created (conversation_id, author_id, created_at DESC)
--
--   Because those leading columns have no equality predicate in the replay
--   query (only IS NOT NULL), Postgres must scan every row in those indexes
--   to find the narrow created_at window — observed 66 000 buffer reads and
--   ~354 ms per query under load on the production DB.
--
-- Fix:
--   Two partial indexes that lead with created_at so the planner can seek
--   directly into the time window and scan only the rows it needs.
--
-- These indexes are created CONCURRENTLY so they do not take an AccessExclusiveLock
-- and do not block live reads or writes. The migrate.ts runner wraps each
-- migration in a transaction, but CONCURRENTLY is incompatible with explicit
-- transactions; the -- no-transaction header above tells the runner to execute
-- this file outside any transaction block. The IF NOT EXISTS guard makes
-- re-runs idempotent.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_channel_created_at_replay
    ON messages (created_at DESC)
    WHERE deleted_at IS NULL AND channel_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conv_created_at_replay
    ON messages (created_at DESC)
    WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;
