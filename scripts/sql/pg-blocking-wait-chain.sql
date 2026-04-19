-- Paste into psql during a POST /messages latency spike (Postgres 9.6+ for pg_blocking_pids).
-- Shows each blocked backend, what it is waiting on, blocking PID(s), and both query texts.
-- lock_target is the relation (or other lock object) for an ungranted lock row on the waiter, when available.

SELECT
  blocked.pid AS blocked_pid,
  blocked.usename AS blocked_user,
  blocked.application_name,
  blocked.state AS blocked_state,
  blocked.wait_event_type,
  blocked.wait_event,
  substring(blocked.query, 1, 600) AS blocked_query,
  blocker.pid AS blocking_pid,
  blocker.usename AS blocking_user,
  substring(blocker.query, 1, 600) AS blocking_query,
  blocked_l.locktype AS blocked_locktype,
  blocked_l.mode AS blocked_lock_mode,
  COALESCE(
    CASE WHEN blocked_l.relation IS NOT NULL
      THEN format('%s.%s', nsp.nspname, cls.relname)
      ELSE NULL
    END,
    CASE WHEN blocked_l.transactionid IS NOT NULL
      THEN format('xid:%s', blocked_l.transactionid)
      ELSE NULL
    END,
    blocked_l.locktype::text
  ) AS lock_target
FROM pg_stat_activity AS blocked
CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS bp(blocking_pid)
JOIN pg_stat_activity AS blocker ON blocker.pid = bp.blocking_pid
LEFT JOIN pg_locks AS blocked_l
  ON blocked_l.pid = blocked.pid
 AND blocked_l.granted = false
LEFT JOIN pg_class AS cls ON cls.oid = blocked_l.relation
LEFT JOIN pg_namespace AS nsp ON nsp.oid = cls.relnamespace
WHERE blocked.pid <> pg_backend_pid()
ORDER BY blocked.pid, blocker.pid, blocked_l.locktype, blocked_l.mode;
