#!/usr/bin/env bash
# Snapshot the heaviest normalized SQL statements from pg_stat_statements.
# Supports either a direct connection URL or an SSH hop to the DB host.
#
# Examples:
#   DATABASE_URL='postgresql://...' ./scripts/pg-stat-statements-snapshot.sh
#   DB_SSH='root@db-host' DB_NAME='chatapp_prod' ./scripts/pg-stat-statements-snapshot.sh
#
# Tunables:
#   LIMIT            default 15
#   MIN_CALLS_MEAN   default 20  (filter noisy one-off statements from mean-latency view)
#   MIN_CALLS_IO     default 5   (filter one-off statements from IO-heavy view)
set -euo pipefail

LIMIT="${LIMIT:-15}"
MIN_CALLS_MEAN="${MIN_CALLS_MEAN:-20}"
MIN_CALLS_IO="${MIN_CALLS_IO:-5}"
DB_NAME="${DB_NAME:-chatapp_prod}"

run_psql() {
  local sql="$1"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -P pager=off -c "${sql}"
    return
  fi

  if [[ -n "${DB_SSH:-}" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "${DB_SSH}" \
      "sudo -u postgres psql -d '${DB_NAME}' -X -v ON_ERROR_STOP=1 -P pager=off -c \"${sql}\""
    return
  fi

  echo "Set DATABASE_URL or DB_SSH to query pg_stat_statements." >&2
  exit 1
}

assert_extension_sql="
SELECT extname
FROM pg_extension
WHERE extname = 'pg_stat_statements';
"

shared_cte="
WITH stats AS (
  SELECT
    queryid,
    calls,
    total_exec_time,
    mean_exec_time,
    rows,
    shared_blks_hit,
    shared_blks_read,
    temp_blks_written,
    regexp_replace(query, E'\\\\s+', ' ', 'g') AS query
  FROM pg_stat_statements
)
"

if ! run_psql "${assert_extension_sql}" | grep -q 'pg_stat_statements'; then
  echo "pg_stat_statements is not enabled on the target database." >&2
  exit 1
fi

echo "=== pg_stat_statements: top total execution time ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  left(query, 180) AS query
FROM stats
ORDER BY total_exec_time DESC
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: slowest mean execution time (calls >= ${MIN_CALLS_MEAN}) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  rows,
  left(query, 180) AS query
FROM stats
WHERE calls >= ${MIN_CALLS_MEAN}
ORDER BY mean_exec_time DESC
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: most IO-heavy (shared reads + temp writes, calls >= ${MIN_CALLS_IO}) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  left(query, 180) AS query
FROM stats
WHERE calls >= ${MIN_CALLS_IO}
ORDER BY (shared_blks_read + temp_blks_written) DESC, mean_exec_time DESC
LIMIT ${LIMIT};
"
