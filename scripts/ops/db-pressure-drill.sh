#!/usr/bin/env bash
# scripts/ops/db-pressure-drill.sh
# Weekly DB scaling readiness drill.
# Captures: pg_stat_statements hotspots, live waiter snapshot, buffer hit rates,
# HOT update rates, index usage, replica lag, and a go/no-go capacity verdict.
#
# Usage:
#   ./scripts/ops/db-pressure-drill.sh
#   DB_HOST=10.0.1.62 DB_PORT=5432 ./scripts/ops/db-pressure-drill.sh
#   ./scripts/ops/db-pressure-drill.sh --write var/db-drill-$(date +%Y%m%d).txt
#
# Requires: SSH access to 130.245.136.44 (or DB_JUMP_HOST) with psql reachable
# at DB_HOST:DB_PORT inside the VPC.

set -euo pipefail

DB_HOST="${DB_HOST:-10.0.1.62}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-chatapp}"
DB_NAME="${DB_NAME:-chatapp_prod}"
DB_PASS="${DB_PASS:-8MwAFHlqyzNOzVMQ86TKzmQ4VuxUIJsM3ZzDldZeCzk=}"
JUMP_HOST="${DB_JUMP_HOST:-130.245.136.44}"
JUMP_USER="${DB_JUMP_USER:-ubuntu}"
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write) OUT="${2:?}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

psql_cmd() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${JUMP_USER}@${JUMP_HOST}" \
    "PGPASSWORD='${DB_PASS}' psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} -t -A -c \"\$1\"" 2>/dev/null
}

run() {
  local title="$1" query="$2"
  echo ""
  echo "=== ${title} ==="
  psql_cmd "$query" || echo "(query failed or no data)"
}

BANNER="=== DB Pressure Drill  $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

emit() {
  if [[ -n "$OUT" ]]; then
    tee -a "$OUT"
  else
    cat
  fi
}

{
  echo "$BANNER"
  echo "  DB_HOST : ${DB_HOST}:${DB_PORT}"
  echo "  DB_NAME : ${DB_NAME}"
  echo "  Jump    : ${JUMP_HOST}"

  # ── 1. Live waiters ─────────────────────────────────────────────────────────
  run "Live pg_stat_activity waiters (wait_event IS NOT NULL)" "
    SELECT pid, wait_event_type, wait_event,
           EXTRACT(EPOCH FROM (now()-query_start))::int AS wait_sec,
           LEFT(query, 120) AS query
    FROM pg_stat_activity
    WHERE wait_event IS NOT NULL
      AND state != 'idle'
      AND query NOT ILIKE '%pg_stat_activity%'
    ORDER BY wait_sec DESC
    LIMIT 20;"

  # ── 2. Longest running queries ───────────────────────────────────────────────
  run "Queries running > 2s right now" "
    SELECT pid,
           EXTRACT(EPOCH FROM (now()-query_start))::int AS running_sec,
           state, wait_event_type, wait_event,
           LEFT(query, 120) AS query
    FROM pg_stat_activity
    WHERE state != 'idle'
      AND query_start < now() - INTERVAL '2 seconds'
      AND query NOT ILIKE '%pg_stat_activity%'
    ORDER BY running_sec DESC
    LIMIT 20;"

  # ── 3. pg_stat_statements top by total time ──────────────────────────────────
  run "Top 15 queries by total execution time (pg_stat_statements)" "
    SELECT
      ROUND(total_exec_time::numeric, 0) AS total_ms,
      calls,
      ROUND(mean_exec_time::numeric, 2)  AS mean_ms,
      ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
      ROUND((total_exec_time / (SELECT SUM(total_exec_time) FROM pg_stat_statements) * 100)::numeric, 1) AS pct_total,
      LEFT(query, 120) AS query
    FROM pg_stat_statements
    ORDER BY total_exec_time DESC
    LIMIT 15;"

  # ── 4. Top queries by mean time (latency outliers) ───────────────────────────
  run "Top 10 queries by mean exec time (latency outliers, calls >= 10)" "
    SELECT
      ROUND(mean_exec_time::numeric, 2)  AS mean_ms,
      calls,
      ROUND(total_exec_time::numeric, 0) AS total_ms,
      LEFT(query, 120) AS query
    FROM pg_stat_statements
    WHERE calls >= 10
    ORDER BY mean_exec_time DESC
    LIMIT 10;"

  # ── 5. Table-level stats (reads, writes, HOT rate) ───────────────────────────
  run "Key table stats: HOT update rate, seq vs index scans" "
    SELECT relname,
      n_live_tup,
      n_tup_ins, n_tup_upd, n_tup_hot_upd,
      CASE WHEN n_tup_upd > 0
           THEN ROUND((n_tup_hot_upd::numeric / n_tup_upd) * 100, 1)
           ELSE NULL END AS hot_pct,
      seq_scan, idx_scan,
      CASE WHEN (seq_scan + idx_scan) > 0
           THEN ROUND((idx_scan::numeric / (seq_scan + idx_scan)) * 100, 1)
           ELSE NULL END AS idx_pct
    FROM pg_stat_user_tables
    WHERE relname IN ('messages','read_states','channel_members','community_members',
                      'channels','users','presence_snapshots')
    ORDER BY n_tup_upd DESC;"

  # ── 6. Unused or redundant indexes ──────────────────────────────────────────
  run "Indexes with zero or very low scans (> 100 MB, idx_scan < 100)" "
    SELECT
      schemaname, tablename, indexname,
      idx_scan,
      idx_tup_read,
      pg_size_pretty(pg_relation_size(indexrelid)) AS size
    FROM pg_stat_user_indexes
    WHERE pg_relation_size(indexrelid) > 100 * 1024 * 1024
      AND idx_scan < 100
    ORDER BY pg_relation_size(indexrelid) DESC
    LIMIT 20;"

  # ── 7. Invalid / in-progress indexes ────────────────────────────────────────
  run "Invalid or not-yet-ready indexes" "
    SELECT c.relname AS tablename, i.relname AS indexname,
           ix.indisvalid, ix.indisready,
           pg_size_pretty(pg_relation_size(i.oid)) AS size
    FROM pg_index ix
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    WHERE NOT ix.indisvalid OR NOT ix.indisready
    ORDER BY pg_relation_size(i.oid) DESC;"

  # ── 8. Buffer cache hit rate ─────────────────────────────────────────────────
  run "Buffer cache hit rate (target > 99%)" "
    SELECT
      SUM(heap_blks_hit) AS heap_hits,
      SUM(heap_blks_read) AS heap_reads,
      CASE WHEN (SUM(heap_blks_hit) + SUM(heap_blks_read)) > 0
           THEN ROUND(SUM(heap_blks_hit)::numeric /
                      (SUM(heap_blks_hit) + SUM(heap_blks_read)) * 100, 3)
           ELSE NULL END AS hit_pct
    FROM pg_statio_user_tables;"

  # ── 9. Table bloat estimate ──────────────────────────────────────────────────
  run "Table sizes and estimated dead tuple ratio" "
    SELECT relname,
      pg_size_pretty(pg_total_relation_size(oid)) AS total_size,
      pg_size_pretty(pg_relation_size(oid)) AS table_size,
      n_dead_tup,
      n_live_tup,
      CASE WHEN n_live_tup > 0
           THEN ROUND((n_dead_tup::numeric / n_live_tup) * 100, 2)
           ELSE NULL END AS dead_pct,
      last_vacuum::date, last_autovacuum::date, last_analyze::date
    FROM pg_stat_user_tables
    JOIN pg_class ON pg_class.relname = pg_stat_user_tables.relname
    ORDER BY pg_total_relation_size(pg_class.oid) DESC
    LIMIT 15;"

  # ── 10. Replication lag ──────────────────────────────────────────────────────
  run "Physical replication lag" "
    SELECT
      client_addr,
      state,
      sent_lsn,
      write_lsn,
      flush_lsn,
      replay_lsn,
      pg_size_pretty(sent_lsn - replay_lsn) AS replay_lag_bytes,
      write_lag,
      flush_lag,
      replay_lag
    FROM pg_stat_replication;"

  # ── 11. PgBouncer pool summary (via psql to pgbouncer admin db) ─────────────
  echo ""
  echo "=== PgBouncer SHOW POOLS (via VM1 localhost:6432) ==="
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${JUMP_USER}@${JUMP_HOST}" \
    "PGPASSWORD='' psql -h 127.0.0.1 -p 6432 -U chatapp pgbouncer -t -A -c 'SHOW POOLS;'" 2>/dev/null \
    || echo "(PgBouncer admin unavailable — check PGBOUNCER_ADMIN_USERS and pg_hba.conf)"

  # ── 12. Verdict ──────────────────────────────────────────────────────────────
  echo ""
  echo "=== Capacity verdict ==="
  echo ""
  # HOT rate check
  hot_pct=$(psql_cmd "
    SELECT COALESCE(
      ROUND((SUM(n_tup_hot_upd)::numeric / NULLIF(SUM(n_tup_upd),0)) * 100, 1),
      0)
    FROM pg_stat_user_tables
    WHERE relname = 'read_states';" 2>/dev/null | tr -d ' ' || echo "unknown")
  echo "  read_states HOT update rate: ${hot_pct}%  (target >50% after fillfactor=70 propagates)"

  # Cache hit rate
  hit_pct=$(psql_cmd "
    SELECT COALESCE(ROUND(SUM(heap_blks_hit)::numeric /
           NULLIF(SUM(heap_blks_hit)+SUM(heap_blks_read),0) * 100, 2), 0)
    FROM pg_statio_user_tables;" 2>/dev/null | tr -d ' ' || echo "unknown")
  echo "  Buffer cache hit rate       : ${hit_pct}%  (target >99%)"

  # Waiter count right now
  waiter_count=$(psql_cmd "
    SELECT COUNT(*) FROM pg_stat_activity
    WHERE wait_event IS NOT NULL AND state != 'idle'
      AND query NOT ILIKE '%pg_stat_activity%';" 2>/dev/null | tr -d ' ' || echo "unknown")
  echo "  Live waiters right now      : ${waiter_count}  (target 0 outside load spikes)"

  echo ""
  echo "  Decision table:"
  echo "    cache_hit < 95%       → shared_buffers too small; increase or add RAM"
  echo "    HOT rate  < 30%       → fillfactor not yet propagated; run VACUUM FULL or wait"
  echo "    HOT rate  < 5%        → possible missing VACUUM or index on updated column"
  echo "    waiter_count > 10     → DB at capacity; scale PgBouncer pool or add DB vCPU"
  echo "    waiter_count > 50     → urgent: scale DB or shed app traffic"
  echo ""
  echo "=== Drill complete ==="
} | emit

if [[ -n "$OUT" ]]; then
  echo "Written to ${OUT}"
fi
