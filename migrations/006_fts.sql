-- ============================================================================
-- 006: Add stored tsvector column for native Postgres full-text search.
--
-- Replaces the ILIKE + Meilisearch approach with a generated column that
-- Postgres maintains automatically on INSERT / UPDATE.  The existing
-- pg_trgm GIN index (idx_messages_content_trgm) stays in place as a
-- fallback for partial / infix matching in the application layer.
-- ============================================================================

-- Computed and stored by Postgres on every INSERT / UPDATE; never stale.
-- coalesce(content, '') means attachment-only messages produce an empty
-- tsvector and never appear in FTS results.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

-- GIN index on the generated column.  Partial: deleted messages are excluded
-- automatically and never take up space or slow down writes.
CREATE INDEX IF NOT EXISTS idx_messages_tsv
  ON messages USING GIN (content_tsv)
  WHERE deleted_at IS NULL;
