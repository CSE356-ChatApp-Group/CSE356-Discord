#!/usr/bin/env bash
# Read-only snapshot: prod app + DB capacity signals (SSH from your laptop).
#
#   PROD_HOST=130.245.136.44 PROD_DB_HOST=130.245.136.21 \
#   PROD_USER=ubuntu ./deploy/analyze-prod-capacity.sh
#
# Requires SSH access to both hosts (same key as deploy).

set -euo pipefail

PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_DB_HOST="${PROD_DB_HOST:-130.245.136.21}"
PROD_USER="${PROD_USER:-ubuntu}"
PROD_POSTGRES_DB="${PROD_POSTGRES_DB:-chatapp_prod}"

ssh_app() { ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_USER}@${PROD_HOST}" "$@"; }
ssh_db() { ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_USER}@${PROD_DB_HOST}" "$@"; }

echo "=== App ${PROD_USER}@${PROD_HOST} ==="
ssh_app 'echo -n "disk /: "; df -h / | tail -1'
ssh_app 'grep -E "^[[:space:]]*maxsize|daily" /etc/logrotate.d/nginx 2>/dev/null | head -5 || echo "(no /etc/logrotate.d/nginx)"'

echo ""
echo "=== PgBouncer SHOW POOLS (app → :6432) ==="
ssh_app "psql -h 127.0.0.1 -p 6432 -U chatapp -d pgbouncer -c 'SHOW POOLS;'" 2>&1 | tail -12

echo ""
echo "=== Per-worker metrics (sample) ==="
for p in 4000 4001 4002 4003 4004; do
  echo "--- :${p} ---"
  # message_post line contains `{` / `}` — escape them for grep -E; close the outer `^(...|...)` group.
  ssh_app "curl -fsS --max-time 3 http://127.0.0.1:${p}/metrics 2>/dev/null" | grep -E \
    '^(pg_pool_waiting|pg_pool_total|pg_pool_idle|pg_pool_circuit_breaker_rejects_total|chatapp_overload_stage|http_overload_shed_total|message_post_response_total\{status_code="(201|503)"\})' \
    || echo "(metrics unavailable)"
done

echo ""
echo "=== DB ${PROD_USER}@${PROD_DB_HOST} ==="
ssh_db 'echo -n "disk /: "; df -h / | tail -1'
ssh_db "sudo -u postgres psql -d \"${PROD_POSTGRES_DB}\" -Atc 'SHOW max_connections;'" | awk '{print "Postgres max_connections:", $0}'
ssh_db "sudo -u postgres psql -d \"${PROD_POSTGRES_DB}\" -c \"SELECT state, count(*) FROM pg_stat_activity WHERE datname IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;\"" 2>&1 | tail -8

echo ""
echo "=== Interpretation (quick) ==="
echo "- PgBouncer cl_waiting > 0 or maxwait > 0 sustained → pooler saturation."
echo "- pg_pool_waiting gauge > 0 on workers → Node pg pool queue building."
echo "- message_post 503 / pg_pool_circuit_breaker_rejects rising → raise POOL_CIRCUIT or reduce DB latency."
echo "Done."
