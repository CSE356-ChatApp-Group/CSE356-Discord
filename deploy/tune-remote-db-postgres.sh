#!/usr/bin/env bash
# Raise max_connections (and work_mem) on the dedicated PostgreSQL VM so PgBouncer
# can use default_pool_size + reserve_pool without sitting on the last few slots.
#
# Typical need: PgBouncer default_pool_size up to 400 + reserve_pool_size ~40 → allow ≥500
# on Postgres, plus headroom for admin / monitoring connections.
#
# Usage:
#   DB_SSH=root@130.245.136.21 ./deploy/tune-remote-db-postgres.sh
#
# Env:
#   REMOTE_PG_MAX_CONNECTIONS  default 550
#   ALLOW_DB_RESTART           default false — set true to restart Postgres when
#                              max_connections requires it (otherwise prints instructions)
#
set -euo pipefail

DB_SSH="${DB_SSH:?Set DB_SSH, e.g. root@db-host}"
TARGET_MAX="${REMOTE_PG_MAX_CONNECTIONS:-550}"
ALLOW_DB_RESTART="${ALLOW_DB_RESTART:-false}"

echo "=== Remote PostgreSQL tuning → ${DB_SSH} (target max_connections=${TARGET_MAX}) ==="

ssh -o BatchMode=yes -o ConnectTimeout=25 "${DB_SSH}" bash -s <<EOF
set -euo pipefail
TARGET_MAX=${TARGET_MAX}
ALLOW_DB_RESTART=${ALLOW_DB_RESTART}
CUR=\$(sudo -u postgres psql -qAt -c "SHOW max_connections;")
echo "Current max_connections=\${CUR}"
if [ "\${CUR}" -ge "\${TARGET_MAX}" ]; then
  echo "Already >= \${TARGET_MAX} — nothing to do."
  exit 0
fi
TOTAL_RAM_MB=\$(awk '/MemTotal/{printf "%d", \$2/1024}' /proc/meminfo)
WRK_MB=\$(python3 -c "ram=int('\${TOTAL_RAM_MB}'); mc=int('\${TARGET_MAX}'); print(max(4, min(64, ram // max(mc * 4, 1))))")
echo "RAM=\${TOTAL_RAM_MB}MB → setting max_connections=${TARGET_MAX}, work_mem=\${WRK_MB}MB"
sudo -u postgres psql -qAt \
  -c "ALTER SYSTEM SET max_connections = '${TARGET_MAX}';" \
  -c "ALTER SYSTEM SET work_mem = '\${WRK_MB}MB';" \
  2>&1 | grep -v 'change directory' || true
# Set statement_timeout on the app role so long-running queries are killed at the
# PG level.  PgBouncer query_timeout=16s kills the PgBouncer→PG connection but
# without this the underlying PG statement continues holding a backend slot and
# consuming CPU until it finishes naturally.  15s leaves 1s before PgBouncer acts.
STMT_TIMEOUT="${STATEMENT_TIMEOUT:-15s}"
sudo -u postgres psql -qAt \
  -c "ALTER ROLE chatapp SET statement_timeout = '\${STMT_TIMEOUT}';" \
  2>&1 | grep -v 'change directory' || true
echo "statement_timeout for chatapp role set to \${STMT_TIMEOUT}."
sudo -u postgres psql -qAt -c "SELECT pg_reload_conf();" >/dev/null || true
PENDING=\$(sudo -u postgres psql -qAt -c "SELECT EXISTS (SELECT 1 FROM pg_settings WHERE pending_restart)")
if [ "\${PENDING}" = "t" ]; then
  if [ "\${ALLOW_DB_RESTART}" = "true" ]; then
    echo "Restarting PostgreSQL to apply max_connections..."
    sudo systemctl restart postgresql
    sleep 3
    sudo systemctl is-active postgresql || { echo "ERROR: postgresql not active after restart"; exit 1; }
  else
    echo "PostgreSQL reports pending_restart — max_connections needs a full restart."
    echo "  Run:  ALLOW_DB_RESTART=true DB_SSH=${DB_SSH} ./deploy/tune-remote-db-postgres.sh"
    echo "  Or:   ssh ${DB_SSH} 'sudo systemctl restart postgresql'"
    exit 2
  fi
fi
NEW=\$(sudo -u postgres psql -qAt -c "SHOW max_connections;")
echo "Done. max_connections is now \${NEW}."
EOF
