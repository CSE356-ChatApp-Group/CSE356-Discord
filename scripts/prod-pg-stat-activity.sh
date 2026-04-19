#!/usr/bin/env bash
# One-shot snapshot of non-idle Postgres backends — run during POST /messages latency spikes
# to see lock waits (e.g. channels row vs INSERT FK).
#
# Usage:
#   bash scripts/prod-pg-stat-activity.sh
#   PROD_DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod bash scripts/prod-pg-stat-activity.sh
set -euo pipefail

PROD_DB_SSH="${PROD_DB_SSH:-ubuntu@130.245.136.21}"
DB_NAME="${DB_NAME:-chatapp_prod}"

ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_DB_SSH}" \
  "sudo -u postgres psql $(printf '%q' "${DB_NAME}") -X -c $(printf '%q' "SELECT pid, wait_event_type, wait_event, state, left(query, 220) AS query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state <> 'idle' ORDER BY wait_event_type NULLS LAST, wait_event NULLS LAST, pid;")"
