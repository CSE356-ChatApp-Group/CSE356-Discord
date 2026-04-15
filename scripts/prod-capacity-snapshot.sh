#!/usr/bin/env bash
# Capture a one-file capacity snapshot on the app host (run via SSH on prod/staging).
# Usage:
#   ssh root@PROD 'bash -s' < scripts/prod-capacity-snapshot.sh
#   ./scripts/prod-capacity-snapshot.sh   # if already on the VM
set -euo pipefail
OUT="${HOME}/chatapp-snapshot-$(date -u +%Y%m%dT%H%M%SZ).txt"
CHATAPP_PORTS="$(
  systemctl list-units 'chatapp@*.service' --type=service --state=running --no-legend 2>/dev/null \
    | sed -n 's/.*chatapp@\([0-9]\+\)\.service.*/\1/p' \
    | sort -n \
    | xargs
)"
if [[ -z "${CHATAPP_PORTS}" ]]; then
  CHATAPP_PORTS="4000 4001"
fi
{
  echo "host=$(hostname) utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=== loadavg (compare to \$(nproc)) ==="
  echo "nproc=$(nproc --all)"
  cut -d' ' -f1-3 /proc/loadavg
  echo "=== memory ==="
  free -h
  echo "=== mpstat all cores 5s ==="
  if command -v mpstat >/dev/null 2>&1; then
    mpstat -P ALL 1 5
  else
    echo "install: apt install -y sysstat"
  fi
  echo "=== top CPU ==="
  ps aux --sort=-%cpu | head -15
  echo "=== health (nginx → one upstream) ==="
  curl -sS -k -m 5 https://127.0.0.1/health 2>/dev/null || curl -sS -m 5 http://127.0.0.1/health || true
  echo
  echo "=== health?diagnostic=1 (machine-readable capacity block per instance below) ==="
  curl -sS -k -m 5 'https://127.0.0.1/health?diagnostic=1' 2>/dev/null || curl -sS -m 5 'http://127.0.0.1/health?diagnostic=1' || true
  echo
  echo "=== direct /health?diagnostic=1 per running instance ==="
  for port in $CHATAPP_PORTS; do
    echo "--- :${port} ---"
    curl -sS -m 5 "http://127.0.0.1:${port}/health?diagnostic=1" 2>/dev/null || true
  done
  echo
  echo "=== selected metrics per running instance ==="
  for port in $CHATAPP_PORTS; do
    echo "--- :${port} ---"
    curl -sS -m 5 "http://127.0.0.1:${port}/metrics" 2>/dev/null \
      | grep -E "nodejs_eventloop_lag_p99|chatapp_overload_stage|pg_pool_(total|idle|waiting)|auth_bcrypt_(active|waiters)|side_effect_queue_(depth|active_workers)" \
      || true
  done
  echo "=== Postgres (if local) ==="
  if sudo -u postgres psql -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    sudo -u postgres psql -d postgres -tAc 'SHOW max_connections;'
    sudo -u postgres psql -d postgres -tAc "SELECT count(*) FROM pg_stat_activity;"
  fi
  echo "=== PgBouncer ini (pool lines) ==="
  grep -E "^default_pool_size|^reserve_pool|^max_client" /etc/pgbouncer/pgbouncer.ini 2>/dev/null || true
} 2>&1 | tee "$OUT"
echo "Wrote $OUT" >&2
