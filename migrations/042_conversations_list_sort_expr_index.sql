-- no-transaction
-- Speeds GET /api/v1/conversations list (cache miss): my_convos CTE orders by
-- COALESCE(c.last_message_at, c.updated_at) DESC before LIMIT 200.
-- Without an expression btree, Postgres sorts all joined rows in memory.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_coalesce_last_activity_desc
  ON conversations ((COALESCE(last_message_at, updated_at)) DESC NULLS LAST);
