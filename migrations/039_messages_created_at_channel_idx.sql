-- no-transaction
-- Migration 039: Drop cross-channel recency index (idx_messages_created_at_channel).
--
-- This index was created experimentally but causes the query planner to choose
-- a global index scan (O(17M rows) with per-row channel filter) over the
-- efficient per-channel nested loop (O(n_channels × recent_rows)). Under the
-- app's workload pattern — scoped to 12–30 channels per community — the
-- per-channel nested loop via idx_messages_channel is consistently faster.
-- Dropping restores the faster plan.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_created_at_channel;
