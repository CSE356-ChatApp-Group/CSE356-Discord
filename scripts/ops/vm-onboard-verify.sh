#!/usr/bin/env bash
# scripts/ops/vm-onboard-verify.sh
# Verifies that a new app VM (e.g. VM4) is ready to receive production traffic.
# Run AFTER host setup, before adding the VM to nginx upstream and Prometheus scrape.
#
# Usage:
#   NEW_VM_HOST=<public-ip> NEW_VM_INTERNAL=<private-ip> \
#     NEW_VM_INSTANCES=6 ./scripts/ops/vm-onboard-verify.sh
#
# What it checks:
#   - SSH connectivity
#   - All expected chatapp@PORT services active
#   - /health responds 200 on each port
#   - PgBouncer reachable on 127.0.0.1:6432
#   - node_exporter reachable on :9100
#   - /metrics reachable on each chatapp port
#   - Key env vars present in /opt/chatapp/shared/.env
#   - nginx NOT running (workers-only VM should not have nginx)
#   - Disk space > 20% free
#   - Memory > 20% free
#   - DB connectivity from the new VM to the PG primary

set -euo pipefail

NEW_VM_HOST="${NEW_VM_HOST:?Usage: NEW_VM_HOST=<ip> NEW_VM_INTERNAL=<ip> NEW_VM_INSTANCES=6 $0}"
NEW_VM_INTERNAL="${NEW_VM_INTERNAL:?}"
NEW_VM_INSTANCES="${NEW_VM_INSTANCES:-6}"
SSH_USER="${NEW_VM_SSH_USER:-ubuntu}"
DB_HOST="${DB_HOST:-10.0.1.62}"
DB_PORT="${DB_PORT:-5432}"
CHATAPP_BASE_PORT=4000

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
PASS=0; WARN=0; FAIL=0

ok()   { PASS=$((PASS+1));  echo "${GREEN}  ✓ PASS${RESET}  $*"; }
warn() { WARN=$((WARN+1));  echo "${YELLOW}  ⚠ WARN${RESET}  $*"; }
fail() { FAIL=$((FAIL+1));  echo "${RED}  ✗ FAIL${RESET}  $*"; }

ssh_vm() { ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
             "${SSH_USER}@${NEW_VM_HOST}" "$@"; }

echo ""
echo "${BOLD}=== VM Onboard Verify  $(date -u +%Y-%m-%dT%H:%M:%SZ) ===${RESET}"
echo "  Host (public)  : ${NEW_VM_HOST}"
echo "  Host (internal): ${NEW_VM_INTERNAL}"
echo "  Instances      : ${NEW_VM_INSTANCES}"
echo ""

# ── 1. SSH ───────────────────────────────────────────────────────────────────
if ssh_vm "echo ok" >/dev/null 2>&1; then
  ok "SSH to ${NEW_VM_HOST}"
else
  fail "SSH to ${NEW_VM_HOST} — cannot continue"
  exit 1
fi

# ── 2. chatapp services ───────────────────────────────────────────────────────
for i in $(seq 0 $((NEW_VM_INSTANCES - 1))); do
  port=$((CHATAPP_BASE_PORT + i))
  state=$(ssh_vm "systemctl is-active chatapp@${port} 2>/dev/null || echo inactive")
  if [[ "$state" == "active" ]]; then
    ok "chatapp@${port} is active"
  else
    fail "chatapp@${port} is ${state}"
  fi
done

# ── 3. /health on each port ───────────────────────────────────────────────────
for i in $(seq 0 $((NEW_VM_INSTANCES - 1))); do
  port=$((CHATAPP_BASE_PORT + i))
  status=$(ssh_vm "curl -so /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/health 2>/dev/null || echo 000")
  if [[ "$status" == "200" ]]; then
    ok "/health :${port} → ${status}"
  else
    fail "/health :${port} → ${status}"
  fi
done

# ── 4. /metrics on each port ──────────────────────────────────────────────────
for i in $(seq 0 $((NEW_VM_INSTANCES - 1))); do
  port=$((CHATAPP_BASE_PORT + i))
  status=$(ssh_vm "curl -so /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/metrics 2>/dev/null || echo 000")
  if [[ "$status" == "200" ]]; then
    ok "/metrics :${port} → ${status}"
  else
    warn "/metrics :${port} → ${status} (prometheus scrape will fail)"
  fi
done

# ── 5. PgBouncer ─────────────────────────────────────────────────────────────
pgb_ok=$(ssh_vm "PGPASSWORD='' psql -h 127.0.0.1 -p 6432 -U chatapp -d pgbouncer -t -A -c 'SHOW VERSION;' 2>/dev/null | head -1 || echo FAIL")
if [[ "$pgb_ok" == FAIL* ]]; then
  fail "PgBouncer on 127.0.0.1:6432 not reachable"
else
  ok "PgBouncer reachable (${pgb_ok})"
fi

# ── 6. DB connectivity via PgBouncer ─────────────────────────────────────────
db_ok=$(ssh_vm "PGPASSWORD=\$(sudo grep 'DB_PASSWORD\|PGPASSWORD' /opt/chatapp/shared/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d \"'\\\"\") \
  psql -h ${DB_HOST} -p ${DB_PORT} -U chatapp -d chatapp_prod -t -A -c 'SELECT 1;' 2>/dev/null || echo FAIL")
if [[ "$db_ok" == "1" ]]; then
  ok "DB connectivity to ${DB_HOST}:${DB_PORT}"
else
  fail "DB connectivity to ${DB_HOST}:${DB_PORT} failed (check PG_URL env and network)"
fi

# ── 7. node_exporter ─────────────────────────────────────────────────────────
ne_ok=$(ssh_vm "curl -so /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:9100/metrics 2>/dev/null || echo 000")
if [[ "$ne_ok" == "200" ]]; then
  ok "node_exporter :9100 → 200"
else
  warn "node_exporter :9100 → ${ne_ok} (Prometheus scrape will not include host metrics)"
fi

# ── 8. nginx NOT running (workers-only VMs) ───────────────────────────────────
nginx_active=$(ssh_vm "systemctl is-active nginx 2>/dev/null || echo inactive")
if [[ "$nginx_active" == "inactive" || "$nginx_active" == "failed" ]]; then
  ok "nginx not running (workers-only VM)"
else
  warn "nginx is ${nginx_active} — unexpected on a workers-only VM (VM1 is the only ingress)"
fi

# ── 9. Key env vars ───────────────────────────────────────────────────────────
for var in REDIS_URL PG_URL DATABASE_URL JWT_SECRET; do
  present=$(ssh_vm "sudo grep -c '^${var}=' /opt/chatapp/shared/.env 2>/dev/null || echo 0" | tr -d ' ')
  if [[ "$present" -ge 1 ]]; then
    ok "Env var ${var} present in /opt/chatapp/shared/.env"
  else
    fail "Env var ${var} MISSING from /opt/chatapp/shared/.env"
  fi
done

# ── 10. Disk space ────────────────────────────────────────────────────────────
disk_pct=$(ssh_vm "df / --output=pcent | tail -1 | tr -d ' %'" || echo "100")
avail=$((100 - disk_pct))
if [[ $avail -ge 30 ]]; then
  ok "Disk space ${avail}% free"
elif [[ $avail -ge 20 ]]; then
  warn "Disk space ${avail}% free (consider cleanup before onboarding)"
else
  fail "Disk space only ${avail}% free — too low"
fi

# ── 11. Memory ───────────────────────────────────────────────────────────────
mem_avail_pct=$(ssh_vm "awk '/MemAvailable/{a=\$2} /MemTotal/{t=\$2} END{printf \"%d\", a*100/t}' /proc/meminfo 2>/dev/null || echo 0")
if [[ $mem_avail_pct -ge 30 ]]; then
  ok "Memory ${mem_avail_pct}% available"
elif [[ $mem_avail_pct -ge 20 ]]; then
  warn "Memory ${mem_avail_pct}% available (tight for ${NEW_VM_INSTANCES} workers)"
else
  fail "Memory ${mem_avail_pct}% available — insufficient"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then
  echo "${GREEN}${BOLD}READY${RESET}  (${PASS} pass / 0 warn / 0 fail)"
  echo ""
  echo "Next steps:"
  echo "  1. Add ${NEW_VM_INTERNAL} ports to nginx upstream on VM1 (edit prod.required.env EXTRA_UPSTREAM_SERVERS_CSV)"
  echo "  2. Add Prometheus scrape targets for ${NEW_VM_INTERNAL} in deploy/render-prometheus-host-config.py"
  echo "  3. Update deploy/inventory-defaults.sh (CHATAPP_INV_VM4_PUBLIC / _INTERNAL)"
  echo "  4. Update docs/infrastructure-inventory.md"
  echo "  5. Run a VM3-only canary deploy, then promote full fleet with new upstream"
  exit 0
elif [[ $FAIL -eq 0 ]]; then
  echo "${YELLOW}${BOLD}READY (with warnings)${RESET}  (${PASS} pass / ${WARN} warn / 0 fail)"
  echo "Review warnings above before adding to upstream."
  exit 0
else
  echo "${RED}${BOLD}NOT READY${RESET}  (${PASS} pass / ${WARN} warn / ${FAIL} fail)"
  echo "Fix failures before adding to production upstream."
  exit 1
fi
