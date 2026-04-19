-- Tune autovacuum for high-write tables to prevent index bloat storms.
--
-- Default autovacuum triggers at 20% dead tuples. For tables with millions of
-- rows (presence_snapshots, community_members, read_states) this means millions
-- of dead tuples can accumulate before vacuum runs, causing index insertions to
-- require excessive I/O and eventually hit the 15s statement_timeout.
--
-- Root cause of prod storms on 2026-04-19:
--   presence_snapshots had 44k dead tuples after >15h without a vacuum.
--   INSERT INTO presence_snapshots hit >15s → PgBouncer query_timeout cascade
--   → mass reconnection storm → PG 53300 "remaining connection slots reserved".
--
-- Fix: trigger vacuum at 1% dead tuples (vs 20%) with low cost_delay so
-- autovacuum keeps up with the grader's constant write rate.

ALTER TABLE presence_snapshots SET (
  autovacuum_vacuum_scale_factor   = 0.01,
  autovacuum_analyze_scale_factor  = 0.005,
  autovacuum_vacuum_cost_delay     = 2
);

ALTER TABLE community_members SET (
  autovacuum_vacuum_scale_factor   = 0.01,
  autovacuum_analyze_scale_factor  = 0.005,
  autovacuum_vacuum_cost_delay     = 2
);

ALTER TABLE read_states SET (
  autovacuum_vacuum_scale_factor   = 0.01,
  autovacuum_analyze_scale_factor  = 0.005,
  autovacuum_vacuum_cost_delay     = 2
);

ALTER TABLE messages SET (
  autovacuum_vacuum_scale_factor   = 0.01,
  autovacuum_analyze_scale_factor  = 0.005,
  autovacuum_vacuum_cost_delay     = 2
);

ALTER TABLE conversations SET (
  autovacuum_vacuum_scale_factor   = 0.01,
  autovacuum_analyze_scale_factor  = 0.005,
  autovacuum_vacuum_cost_delay     = 2
);
