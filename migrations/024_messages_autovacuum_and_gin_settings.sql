-- migrations/024_messages_autovacuum_and_gin_settings.sql
-- Applied live 2026-04-20: fixes GIN pending list flush at COMMIT
-- and prevents autovacuum starvation on the messages table

ALTER TABLE messages SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay = 2
);

ALTER INDEX idx_messages_tsv SET (
  fastupdate = off,
  gin_pending_list_limit = 32768
);
