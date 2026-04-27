#!/usr/bin/env bash
# One-shot snapshot of non-idle Postgres backends — run during route latency / 5xx spikes
# (including low RPS): shows lock waits and longest-running statements.
#
# Usage:
#   bash scripts/prod-pg-stat-activity.sh
#   PROD_DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod bash scripts/prod-pg-stat-activity.sh
#
# Set MODE=wait to only print wait_event ordering (legacy).
set -euo pipefail

PROD_DB_SSH="${PROD_DB_SSH:-ubuntu@130.245.136.21}"
DB_NAME="${DB_NAME:-chatapp_prod}"
MODE="${MODE:-all}"

run_sql() {
  local sql="$1"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_DB_SSH}" \
    "sudo -u postgres psql $(printf '%q' "${DB_NAME}") -X -c $(printf '%q' "${sql}")"
}

if [[ "${MODE}" == "wait" || "${MODE}" == "all" ]]; then
  echo "=== Non-idle backends (by wait_event) ==="
  run_sql "SELECT pid, wait_event_type, wait_event, state, left(query, 220) AS query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state <> 'idle' ORDER BY wait_event_type NULLS LAST, wait_event NULLS LAST, pid;"
fi

if [[ "${MODE}" == "longest" || "${MODE}" == "all" ]]; then
  echo ""
  echo "=== Longest-running ACTIVE backends (excludes Client/* waits — those are not SQL CPU) ==="
  run_sql "SELECT now() - query_start AS duration, wait_event_type, wait_event, left(query, 400) AS query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query_start IS NOT NULL AND wait_event_type IS DISTINCT FROM 'Client' ORDER BY duration DESC NULLS LAST LIMIT 15;"
  echo ""
  echo "=== Oldest idle-in-transaction (client held transaction open) ==="
  run_sql "SELECT now() - xact_start AS xact_age, now() - state_change AS state_age, left(query, 300) AS last_query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND xact_start IS NOT NULL ORDER BY xact_start LIMIT 15;"
fi
