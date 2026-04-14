#!/usr/bin/env bash
# Reduce checkpoint-induced read latency spikes on write-heavy Postgres (observed:
# long checkpoint writes on a ~5min cadence under grader load). Uses ALTER SYSTEM
# + pg_reload_conf() — no restart required for these parameters on PostgreSQL 16.
#
# Defaults (override with env):
#   CHECKPOINT_TIMEOUT       default 15min
#   MAX_WAL_SIZE             default 4GB
#   CHECKPOINT_COMP_TARGET   default 0.9
#
# Usage:
#   DB_SSH=root@db-host ./deploy/tune-postgres-checkpoints.sh
#
set -euo pipefail

DB_SSH="${DB_SSH:?Set DB_SSH, e.g. root@130.245.136.21}"
CHECKPOINT_TIMEOUT="${CHECKPOINT_TIMEOUT:-15min}"
MAX_WAL_SIZE="${MAX_WAL_SIZE:-4GB}"
CHECKPOINT_COMP_TARGET="${CHECKPOINT_COMP_TARGET:-0.9}"

echo "=== Postgres checkpoint tuning → ${DB_SSH} ==="
echo "    checkpoint_timeout=${CHECKPOINT_TIMEOUT} max_wal_size=${MAX_WAL_SIZE} checkpoint_completion_target=${CHECKPOINT_COMP_TARGET}"

ssh -o BatchMode=yes -o ConnectTimeout=25 "${DB_SSH}" \
  bash -s -- "${CHECKPOINT_TIMEOUT}" "${MAX_WAL_SIZE}" "${CHECKPOINT_COMP_TARGET}" <<'REMOTE'
set -euo pipefail
CT="$1"
MWS="$2"
CCT="$3"
# Reject injection via env (values are interpolated into SQL strings).
case "$CT$MWS$CCT" in
  *\'*|*\"*|*\`*|\$*) echo "ERROR: checkpoint tuning values must not contain quotes or shell metacharacters"; exit 1 ;;
esac
run_sql() { sudo -u postgres psql -qAt -v ON_ERROR_STOP=1 "$@"; }

cur_ct="$(run_sql -c "SHOW checkpoint_timeout;")"
cur_mws="$(run_sql -c "SHOW max_wal_size;")"
cur_cct="$(run_sql -c "SHOW checkpoint_completion_target;")"

echo "Current: checkpoint_timeout=${cur_ct} max_wal_size=${cur_mws} checkpoint_completion_target=${cur_cct}"

if [ "${cur_ct}" = "${CT}" ] && [ "${cur_mws}" = "${MWS}" ] && [ "${cur_cct}" = "${CCT}" ]; then
  echo "Already at target — nothing to do."
  exit 0
fi

if [ "${cur_ct}" != "${CT}" ]; then
  run_sql -c "ALTER SYSTEM SET checkpoint_timeout = '${CT}';"
fi
if [ "${cur_mws}" != "${MWS}" ]; then
  run_sql -c "ALTER SYSTEM SET max_wal_size = '${MWS}';"
fi
if [ "${cur_cct}" != "${CCT}" ]; then
  run_sql -c "ALTER SYSTEM SET checkpoint_completion_target = '${CCT}';"
fi

run_sql -c "SELECT pg_reload_conf();" >/dev/null

echo "New: checkpoint_timeout=$(run_sql -c 'SHOW checkpoint_timeout;') max_wal_size=$(run_sql -c 'SHOW max_wal_size;') checkpoint_completion_target=$(run_sql -c 'SHOW checkpoint_completion_target;')"
echo "Done. Monitor DB iowait + search p95 after 10–15 minutes."
REMOTE
