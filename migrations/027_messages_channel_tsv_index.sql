-- no-transaction
-- Community-scoped search needs a direct access path for:
--   channel_id = <readable channel> AND content_tsv @@ <query>
-- so Postgres can avoid scanning every message in each readable channel and
-- applying the FTS predicate row-by-row.

CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_channel_tsv
ON messages USING gin (channel_id, content_tsv)
WHERE deleted_at IS NULL;
