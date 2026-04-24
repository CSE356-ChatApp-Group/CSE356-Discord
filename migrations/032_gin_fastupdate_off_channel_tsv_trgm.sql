-- Migration 032: Disable GIN fastupdate on idx_messages_channel_tsv and idx_messages_content_trgm
--
-- Root cause of 2432ms tx_insert_ms spikes on hot channels:
--   Both indexes use the default fastupdate=on with gin_pending_list_limit=4MB.
--   Under sustained hot-channel traffic the pending list fills to 4MB and the
--   next INSERT triggers a synchronous ginInsertCleanup, blocking the insert
--   statement for 2-3 seconds and holding the Redis channel insert lock for the
--   full duration — causing lock-waiter timeouts (503s) for concurrent workers.
--
--   idx_messages_tsv was corrected in migration 024 with the same settings.
--   idx_messages_channel_tsv was added in migration 028 without applying the fix.
--   idx_messages_content_trgm was missed in migration 024.
--
-- Fix: fastupdate=off makes GIN updates synchronous but constant-time per insert
-- (no batching, no thundering-herd flush). gin_pending_list_limit=32768 is kept
-- for consistency with idx_messages_tsv but has no effect when fastupdate=off.
--
-- ALTER INDEX SET requires only ShareUpdateExclusiveLock — safe under live traffic,
-- does not block concurrent reads or writes. Existing pending list entries are
-- cleaned up by the next autovacuum run (not during this migration).

ALTER INDEX idx_messages_channel_tsv SET (fastupdate = off, gin_pending_list_limit = 32768);
ALTER INDEX idx_messages_content_trgm SET (fastupdate = off, gin_pending_list_limit = 32768);
