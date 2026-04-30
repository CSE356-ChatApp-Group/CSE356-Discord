#!/usr/bin/env bash
# List pg_stat_statements rows for INSERT INTO read_states (Redis batch flush upsert).
# Use after multi-VM deploys to confirm a single SQL fingerprint dominates; several rows
# usually mean mixed app versions across workers or cumulative history since stats_reset.
#
#   PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/postgres/pg-stat-read-state-flush-fingerprints.sh
#   DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod ./scripts/postgres/pg-stat-read-state-flush-fingerprints.sh
set -euo pipefail

DB_NAME="${DB_NAME:-chatapp_prod}"
DB_SSH="${DB_SSH:-${PROD_DB_SSH:-}}"

run_psql() {
  local sql="$1"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -P pager=off -c "${sql}"
    return
  fi
  if [[ -n "${DB_SSH:-}" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "${DB_SSH}" \
      "sudo -u postgres psql $(printf '%q' "${DB_NAME}") -X -v ON_ERROR_STOP=1 -P pager=off -c $(printf '%q' "${sql}")"
    return
  fi
  echo "Set DATABASE_URL or DB_SSH (or PROD_DB_SSH)." >&2
  exit 1
}

echo "=== read_states INSERT fingerprints (pg_stat_statements) ==="
run_psql "
SELECT
  queryid,
  calls,
  round(mean_exec_time::numeric, 2) AS mean_ms,
  round(stddev_exec_time::numeric, 2) AS stddev_ms,
  round(max_exec_time::numeric, 2) AS max_ms,
  left(regexp_replace(query, E'\\\\s+', ' ', 'g'), 220) AS query
FROM pg_stat_statements
WHERE query ILIKE '%INSERT INTO read_states%'
ORDER BY calls DESC NULLS LAST;
"
