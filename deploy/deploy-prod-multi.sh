#!/bin/bash
# deploy/deploy-prod-multi.sh
# Three-VM production deploy orchestrator.
# Deploys to VM3 first, then VM2 (both workers-only), then VM1 (shared services).
#
# Usage: bash deploy/deploy-prod-multi.sh <release-sha>
#   --rollback    Pass through to all VM deploys (fast rollback mode)
#
# VM3 (130.245.136.54)  runs Node workers only; no shared services.
# VM2 (130.245.136.137) runs Node workers only; no shared services.
# VM1 (130.245.136.44)  runs Node workers + PgBouncer + Redis + MinIO + nginx.
# All share DB/Redis/PgBouncer via VM1's internal IP (10.0.0.237).

set -euo pipefail

SHA=${1:?Usage: deploy-prod-multi.sh <sha> [--rollback]}
ROLLBACK_FLAG="${2:-}"

VM1=130.245.136.44
VM2=130.245.136.137
VM3=130.245.136.54
VM2_INTERNAL=10.0.3.243
VM3_INTERNAL=10.0.2.164
PROD_USER="${PROD_USER:-ubuntu}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM1_WORKER_PORTS=(4000 4001 4002 4003)
VMX_WORKER_PORTS=(4000 4001 4002 4003 4004)

# Extra OpenSSH options — mirrors deploy-prod.sh default
DEPLOY_SSH_EXTRA_OPTS="${DEPLOY_SSH_EXTRA_OPTS:--o StrictHostKeyChecking=accept-new}"

ssh_vm() {
  local host="$1"; shift
  # shellcheck disable=SC2086
  ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="/tmp/ssh-chatapp-multi-%r@${host}:%p" \
      -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${host}" "$@"
}

# Extra upstream servers to inject on every rewrite_nginx_upstream call during VM1 deploy.
EXTRA_UPSTREAM_CSV="${VM2_INTERNAL}:4000,${VM2_INTERNAL}:4001,${VM2_INTERNAL}:4002,${VM2_INTERNAL}:4003,${VM2_INTERNAL}:4004,${VM3_INTERNAL}:4000,${VM3_INTERNAL}:4001,${VM3_INTERNAL}:4002,${VM3_INTERNAL}:4003,${VM3_INTERNAL}:4004"

echo "======================================================================"
echo "=== Three-VM Production Deploy: ${SHA:0:12}                      ==="
echo "=== VM1 (nginx/PgBouncer/Redis): ${VM1}            ==="
echo "=== VM2 (workers only):          ${VM2}           ==="
echo "=== VM3 (workers only):          ${VM3}            ==="
echo "======================================================================"
echo ""

# ── Phase 0: Deploy to VM3 first ─────────────────────────────────────────────
# VM3 has no shared services so a failed deploy has zero impact on live traffic.
echo "=== Phase 0: Deploy to VM3 (isolated — no live-traffic impact) ==="
PROD_HOST=$VM3 \
  SKIP_BACKUP=true \
  SKIP_UPSTREAM_PARITY_CHECK=1 \
  ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT=false \
  DEPLOY_NON_INTERACTIVE=true \
  ${ROLLBACK_FLAG:+FAST_ROLLBACK=true} \
  bash "${SCRIPT_DIR}/deploy-prod.sh" "$SHA" ${ROLLBACK_FLAG}

# ── Phase 0.5: Verify VM3 healthy ────────────────────────────────────────────
echo ""
echo "=== Phase 0.5: Verify all 5 VM3 workers healthy ==="
all_ok=1
for p in 4000 4001 4002 4003 4004; do
  status=$(ssh_vm "$VM3" "curl -sf --max-time 8 http://127.0.0.1:${p}/health | python3 -c \"import sys,json; print(json.load(sys.stdin)['status'])\"" 2>/dev/null || echo "DEAD")
  echo "  VM3 worker ${p}: ${status}"
  if [ "$status" != "ok" ]; then
    all_ok=0
  fi
done
if [ "$all_ok" -ne 1 ]; then
  echo "ERROR: One or more VM3 workers unhealthy — aborting before touching VM2/VM1."
  exit 1
fi
echo "✓ All VM3 workers healthy"

# ── Phase 1: Deploy to VM2 ───────────────────────────────────────────────────
# VM2 has no shared services so a failed deploy has zero impact on live traffic.
echo ""
echo "=== Phase 1: Deploy to VM2 (isolated — no live-traffic impact) ==="
PROD_HOST=$VM2 \
  SKIP_BACKUP=true \
  SKIP_UPSTREAM_PARITY_CHECK=1 \
  ${ROLLBACK_FLAG:+FAST_ROLLBACK=true} \
  bash "${SCRIPT_DIR}/deploy-prod.sh" "$SHA" ${ROLLBACK_FLAG}

# ── Phase 2: Verify VM2 healthy before touching VM1 ──────────────────────────
echo ""
echo "=== Phase 2: Verify all 5 VM2 workers healthy ==="
all_ok=1
for p in 4000 4001 4002 4003 4004; do
  status=$(ssh_vm "$VM2" "curl -sf --max-time 8 http://127.0.0.1:${p}/health | python3 -c \"import sys,json; print(json.load(sys.stdin)['status'])\"" 2>/dev/null || echo "DEAD")
  echo "  VM2 worker ${p}: ${status}"
  if [ "$status" != "ok" ]; then
    all_ok=0
  fi
done
if [ "$all_ok" -ne 1 ]; then
  echo "ERROR: One or more VM2 workers unhealthy — aborting before touching VM1."
  echo "       VM1/VM3 are still on their previous releases."
  exit 1
fi
echo "✓ All VM2 workers healthy"

# ── Phase 3: Deploy to VM1 ───────────────────────────────────────────────────
# Pass VM2_UPSTREAM_CSV so rewrite_nginx_upstream preserves VM2 entries throughout
# the rolling restart.  SKIP_UPSTREAM_PARITY_CHECK is NOT set here — the gate runs
# normally and verifies VM1 localhost workers are active and in upstream.
echo ""
echo "=== Phase 3: Deploy to VM1 (PgBouncer/Redis/MinIO/nginx) ==="
PROD_HOST=$VM1 \
  EXTRA_UPSTREAM_SERVERS_CSV="$EXTRA_UPSTREAM_CSV" \
  ${ROLLBACK_FLAG:+FAST_ROLLBACK=true} \
  bash "${SCRIPT_DIR}/deploy-prod.sh" "$SHA" ${ROLLBACK_FLAG}

# ── Phase 4: Ensure VM2+VM3 upstream entries survived the VM1 deploy ─────────
# rewrite_nginx_upstream now preserves EXTRA_UPSTREAM_SERVERS_CSV entries, so this
# is a belt-and-suspenders check.  If entries are missing, re-inject with Python.
echo ""
echo "=== Phase 4: Verify / re-inject VM2+VM3 upstream entries ==="
ssh_vm "$VM1" "
  set -euo pipefail
  SITE=/etc/nginx/sites-enabled/chatapp
  missing=0
  grep -q '${VM2_INTERNAL}' \"\$SITE\" || missing=1
  grep -q '${VM3_INTERNAL}' \"\$SITE\" || missing=1
  if [ \"\$missing\" = \"0\" ]; then
    echo 'VM2+VM3 upstream entries intact — no action needed'
    exit 0
  fi
  echo 'Upstream entries missing — re-injecting...'
  TMP=\$(mktemp)
  sudo cp \"\$SITE\" \"\$TMP\"
  sudo python3 -c \"
import re, sys
from pathlib import Path

site = Path('\$TMP')
text = site.read_text()

extra_servers = (
    '  server ${VM2_INTERNAL}:4000 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM2_INTERNAL}:4001 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM2_INTERNAL}:4002 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM2_INTERNAL}:4003 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM2_INTERNAL}:4004 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM3_INTERNAL}:4000 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM3_INTERNAL}:4001 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM3_INTERNAL}:4002 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM3_INTERNAL}:4003 max_fails=2 fail_timeout=10s;\\\n'
    '  server ${VM3_INTERNAL}:4004 max_fails=2 fail_timeout=10s;\\\n'
)

def inject(m):
    block = m.group(0)
    if '${VM2_INTERNAL}' in block and '${VM3_INTERNAL}' in block:
        return block
    return re.sub(r'(  keepalive \d+;)', extra_servers + r'\1', block, count=1)

text, n = re.subn(r'upstream app \{[^}]+\}', inject, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('upstream app block not found')
site.write_text(text)
\"
  sudo install -m 644 \"\$TMP\" \"\$SITE\"
  rm -f \"\$TMP\"
  sudo nginx -t && sudo systemctl reload nginx
  echo 'VM2+VM3 upstream entries re-injected and nginx reloaded'
"

# ── Phase 5: Final health check — all 14 workers across all VMs ──────────────
echo ""
echo "=== Phase 5: Final health check — all 14 workers ==="
overall_ok=1
for vm in "$VM1" "$VM2" "$VM3"; do
  label="VM1"
  [ "$vm" = "$VM2" ] && label="VM2"
  [ "$vm" = "$VM3" ] && label="VM3"
  ports=("${VMX_WORKER_PORTS[@]}")
  if [ "$vm" = "$VM1" ]; then
    ports=("${VM1_WORKER_PORTS[@]}")
  fi
  ports_list="${ports[*]}"
  echo "--- ${label} (${vm}) ---"
  # shellcheck disable=SC2029
  ssh_vm "$vm" "for p in ${ports_list}; do
    echo -n \"  Worker \$p: \"
    curl -sf --max-time 8 http://127.0.0.1:\$p/health 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); c=d[\"capacity\"]; print(d[\"status\"], \"lag=\"+str(c[\"event_loop_lag_p99_ms\"])+\"ms stage=\"+str(c[\"overload_stage\"]))' 2>/dev/null || echo \"DEAD\"
  done" || overall_ok=0
done

echo ""
if [ "$overall_ok" -eq 1 ]; then
  echo "======================================================================"
  echo "=== Deploy complete: ${SHA:0:12} live on all three VMs          ==="
  echo "======================================================================"
else
  echo "WARNING: One or more workers may be degraded — check output above."
  exit 1
fi
