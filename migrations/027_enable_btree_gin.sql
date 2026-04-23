-- Enable btree_gin so community-scoped search can use a multicolumn
-- GIN index on (channel_id, content_tsv).

CREATE EXTENSION IF NOT EXISTS btree_gin;
