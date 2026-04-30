-- Run during a live write stall. This walks the full blocking chain, not just
-- the first waiter -> blocker hop, and annotates the waiter with the specific
-- ungranted lock target when Postgres exposes it.
--
-- Example:
--   psql "$DATABASE_URL" -f scripts/postgres/sql/pg-blocking-wait-chain.sql
--
-- Requires pg_blocking_pids() (Postgres 9.6+).

WITH RECURSIVE wait_chain AS (
  SELECT
    blocked.pid AS root_blocked_pid,
    0 AS chain_depth,
    ARRAY[blocked.pid, blocker.pid]::int[] AS visited_pids,
    blocked.pid AS blocked_pid,
    blocker.pid AS blocking_pid,
    blocked.usename AS blocked_user,
    blocked.application_name AS blocked_app,
    blocked.state AS blocked_state,
    blocked.wait_event_type AS blocked_wait_event_type,
    blocked.wait_event AS blocked_wait_event,
    age(clock_timestamp(), blocked.query_start) AS blocked_query_age,
    age(clock_timestamp(), blocked.xact_start) AS blocked_xact_age,
    substring(blocked.query, 1, 600) AS blocked_query,
    blocker.usename AS blocking_user,
    blocker.application_name AS blocking_app,
    blocker.state AS blocking_state,
    age(clock_timestamp(), blocker.query_start) AS blocking_query_age,
    age(clock_timestamp(), blocker.xact_start) AS blocking_xact_age,
    substring(blocker.query, 1, 600) AS blocking_query
  FROM pg_stat_activity AS blocked
  CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp(blocking_pid)
  JOIN pg_stat_activity AS blocker
    ON blocker.pid = bp.blocking_pid
  WHERE blocked.pid <> pg_backend_pid()

  UNION ALL

  SELECT
    wait_chain.root_blocked_pid,
    wait_chain.chain_depth + 1,
    wait_chain.visited_pids || next_blocker.pid,
    current_blocker.pid AS blocked_pid,
    next_blocker.pid AS blocking_pid,
    current_blocker.usename AS blocked_user,
    current_blocker.application_name AS blocked_app,
    current_blocker.state AS blocked_state,
    current_blocker.wait_event_type AS blocked_wait_event_type,
    current_blocker.wait_event AS blocked_wait_event,
    age(clock_timestamp(), current_blocker.query_start) AS blocked_query_age,
    age(clock_timestamp(), current_blocker.xact_start) AS blocked_xact_age,
    substring(current_blocker.query, 1, 600) AS blocked_query,
    next_blocker.usename AS blocking_user,
    next_blocker.application_name AS blocking_app,
    next_blocker.state AS blocking_state,
    age(clock_timestamp(), next_blocker.query_start) AS blocking_query_age,
    age(clock_timestamp(), next_blocker.xact_start) AS blocking_xact_age,
    substring(next_blocker.query, 1, 600) AS blocking_query
  FROM wait_chain
  JOIN pg_stat_activity AS current_blocker
    ON current_blocker.pid = wait_chain.blocking_pid
  CROSS JOIN LATERAL unnest(pg_blocking_pids(current_blocker.pid)) AS bp(blocking_pid)
  JOIN pg_stat_activity AS next_blocker
    ON next_blocker.pid = bp.blocking_pid
  WHERE NOT next_blocker.pid = ANY(wait_chain.visited_pids)
),
waiting_lock_targets AS (
  SELECT
    lock_rows.pid,
    COALESCE(
      CASE
        WHEN lock_rows.relation IS NOT NULL
          THEN format('%s.%s', lock_ns.nspname, lock_cls.relname)
        ELSE NULL
      END,
      CASE
        WHEN lock_rows.transactionid IS NOT NULL
          THEN format('xid:%s', lock_rows.transactionid)
        ELSE NULL
      END,
      lock_rows.locktype::text
    ) || ' [' || lock_rows.mode || ']' AS waiting_on
  FROM pg_locks AS lock_rows
  LEFT JOIN pg_class AS lock_cls
    ON lock_cls.oid = lock_rows.relation
  LEFT JOIN pg_namespace AS lock_ns
    ON lock_ns.oid = lock_cls.relnamespace
  WHERE lock_rows.granted = false
),
waiting_locks AS (
  SELECT
    pid,
    string_agg(waiting_on, ', ' ORDER BY waiting_on) AS waiting_on
  FROM (
    SELECT DISTINCT pid, waiting_on
    FROM waiting_lock_targets
  ) AS deduped
  GROUP BY pid
)
SELECT
  wait_chain.root_blocked_pid,
  wait_chain.chain_depth,
  wait_chain.blocked_pid,
  wait_chain.blocked_user,
  wait_chain.blocked_app,
  wait_chain.blocked_state,
  wait_chain.blocked_wait_event_type,
  wait_chain.blocked_wait_event,
  wait_chain.blocked_query_age,
  wait_chain.blocked_xact_age,
  COALESCE(waiting_locks.waiting_on, 'n/a') AS blocked_waiting_on,
  wait_chain.blocking_pid,
  wait_chain.blocking_user,
  wait_chain.blocking_app,
  wait_chain.blocking_state,
  wait_chain.blocking_query_age,
  wait_chain.blocking_xact_age,
  wait_chain.blocked_query,
  wait_chain.blocking_query
FROM wait_chain
LEFT JOIN waiting_locks
  ON waiting_locks.pid = wait_chain.blocked_pid
ORDER BY
  wait_chain.root_blocked_pid,
  wait_chain.chain_depth,
  wait_chain.blocked_pid,
  wait_chain.blocking_pid;
