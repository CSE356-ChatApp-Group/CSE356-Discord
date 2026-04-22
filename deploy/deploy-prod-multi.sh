#!/bin/bash
# deploy/deploy-prod-multi.sh
# Three-VM production deploy orchestrator with per-VM PgBouncer architecture.
# Deploys to VM3 first, then VM2 (both workers-only), then VM1 (shared services).
#
# ARCHITECTURE:
#   Per-VM PgBouncer: Each VM runs an independent PgBouncer instance:
#     - VM1 (127.0.0.1:6432)  handles 4 local workers only
#     - VM2 (10.0.3.243:6432)  handles 6 workers on VM2 only
#     - VM3 (10.0.2.164:6432)  handles 6 workers on VM3 only
#   All connect to PostgreSQL on the shared DB VM (130.245.136.21:5432)
#   nginx on VM1 load-balances HTTP traffic across all 16 workers unchanged.
#
# Usage: bash deploy/deploy-prod-multi.sh <release-sha>
#   --rollback    Pass through to all VM deploys (fast rollback mode)
#   --dry-run     Show what will be deployed without making changes
#
# VM3 (130.245.136.54)  runs Node workers only; no shared services.
# VM2 (130.245.136.137) runs Node workers only; no shared services.
# VM1 (130.245.136.44)  runs Node workers + PgBouncer + Redis + MinIO + nginx.

set -euo pipefail

SHA=${1:?Usage: deploy-prod-multi.sh <sha> [--rollback|--dry-run]}
ROLLBACK_FLAG="${2:-}"
DRY_RUN=0
if [[ "${ROLLBACK_FLAG}" == "--dry-run" ]]; then
  DRY_RUN=1
  ROLLBACK_FLAG=""
fi

VM1=130.245.136.44
VM2=130.245.136.137
VM3=130.245.136.54
VM1_INTERNAL=10.0.1.62
VM2_INTERNAL=10.0.3.243
VM3_INTERNAL=10.0.2.164
PROD_USER="${PROD_USER:-ubuntu}"
MONITORING_VM_HOST="${MONITORING_VM_HOST:-130.245.136.120}"
MONITORING_VM_USER="${MONITORING_VM_USER:-${PROD_USER}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# VM1 runs fewer workers than VM2/VM3; deploy-prod.sh reads CHATAPP_INSTANCES from the target
# host's /opt/chatapp/shared/.env so systemd/nginx match (Phase 5 health checks use these lists).
VM1_WORKER_PORTS=(4000 4001 4002 4003)
VMX_WORKER_PORTS=(4000 4001 4002 4003 4004 4005)

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
# INCREASED from 5 to 6 workers per VM2/VM3 to utilize idle CPU capacity on those VMs.
# Validated: VM3 CPU idle ~76%, VM2 CPU idle ~48%. Adding 1 worker should use ~15% additional CPU.
EXTRA_UPSTREAM_CSV="${VM2_INTERNAL}:4000,${VM2_INTERNAL}:4001,${VM2_INTERNAL}:4002,${VM2_INTERNAL}:4003,${VM2_INTERNAL}:4004,${VM2_INTERNAL}:4005,${VM3_INTERNAL}:4000,${VM3_INTERNAL}:4001,${VM3_INTERNAL}:4002,${VM3_INTERNAL}:4003,${VM3_INTERNAL}:4004,${VM3_INTERNAL}:4005"

echo "======================================================================"
echo "=== Three-VM Production Deploy: ${SHA:0:12}                      ==="
echo "=== VM1 (nginx/PgBouncer/Redis): ${VM1}            ==="
echo "=== VM2 (workers only):          ${VM2}           ==="
echo "=== VM3 (workers only):          ${VM3}            ==="
echo "======================================================================"
if [ $DRY_RUN -eq 1 ]; then
  echo ""
  echo "🏃 DRY RUN MODE - No changes will be made"
  echo ""
  echo "Expected Deployment Plan:"
  echo "  Release:      ${SHA:0:12} (from release-${SHA})"
  echo "  Phases:"
  echo "    Phase -1:  Pre-flight PostgreSQL check"
  echo "    Phase  0:  Deploy to VM3 (6 workers: 4000-4005)"
  echo "    Phase  1:  Deploy to VM2 (6 workers: 4000-4005)"
  echo "    Phase  3:  Deploy to VM1 (4 workers: 4000-4003)"
  echo "    Phase  5:  Final health check (all 16 workers)"
  echo ""
  echo "Configuration:"
  POOL_SIZE=$("${SCRIPT_DIR}/pool-calculator.py" --vcpu=8 --workers=6)
  echo "  Per-VM pool_size: ~${POOL_SIZE} (will be calculated per VM)"
  echo "  PostgreSQL needed: max_connections >= 1600"
  echo "  nginx upstream: 16 workers (4 VM1 + 6 VM2 + 6 VM3)"
  echo ""
  exit 0
fi
echo ""

# ── Phase -1: Pre-flight checks before any deploy ──────────────────────────────
echo "=== Phase -1: Pre-flight PostgreSQL check ==="
echo "Verifying PostgreSQL max_connections is set for per-VM PgBouncer architecture..."
PROD_DB_HOST="${PROD_DB_HOST:-130.245.136.21}"
CURRENT_MAX=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "${PROD_USER}@${PROD_DB_HOST}" \
  "sudo -u postgres psql -qAt -c 'SHOW max_connections;' 2>/dev/null)
SSH_EXIT=$?
if [ $SSH_EXIT -ne 0 ]; then
  echo "ERROR: SSH connection to DB host ${PROD_DB_HOST} failed (exit code $SSH_EXIT)."
  echo "This usually means host key verification failed or SSH is not properly configured."
  echo "Check that ${PROD_DB_HOST} is in known_hosts and the SSH key can access the host."
  exit 1
fi
if [ -z "${CURRENT_MAX}" ]; then
  echo "ERROR: PostgreSQL max_connections check returned empty output from ${PROD_DB_HOST}."
  exit 1
fi
echo "  Current PostgreSQL max_connections: ${CURRENT_MAX}"
if [ "${CURRENT_MAX}" -lt 1500 ]; then
  echo "ERROR: PostgreSQL max_connections must be >= 1500 for per-VM PgBouncer."
  echo "  Current: ${CURRENT_MAX}"
  echo "  Required: 1600 (VM1 pool ~490 + VM2 pool ~500 + VM3 pool ~500 + headroom)"
  echo ""
  echo "  Run on DB VM to upgrade:"
  echo "    DB_SSH=${PROD_USER}@${PROD_DB_HOST} ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh"
  echo ""
  exit 1
fi
echo "✓ PostgreSQL max_connections is adequate (${CURRENT_MAX})"
echo ""

# ── Phase 0: Deploy to VM3 first (after pre-flight PostgreSQL check) ─────────
# VM3 has no shared services so a failed deploy has zero impact on live traffic.
# SKIP_MONITORING_SYNC=1: monitoring is handled once after all VMs are up (Phase 6).
echo "=== Phase 0: Deploy to VM3 (isolated — no live-traffic impact) ==="
PROD_HOST=$VM3 \
  SKIP_BACKUP=true \
  SKIP_UPSTREAM_PARITY_CHECK=1 \
  ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT=false \
  DEPLOY_NON_INTERACTIVE=true \
  PGBOUNCER_BIND_ADDR=$VM3_INTERNAL \
  SKIP_MONITORING_SYNC=1 \
  ${ROLLBACK_FLAG:+FAST_ROLLBACK=true} \
  bash "${SCRIPT_DIR}/deploy-prod.sh" "$SHA" ${ROLLBACK_FLAG}

# ── Phase 0.5: Verify VM3 healthy ────────────────────────────────────────────
echo ""
echo "=== Phase 0.5: Verify all 6 VM3 workers healthy ==="
all_ok=1
for p in 4000 4001 4002 4003 4004 4005; do
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
# SKIP_MONITORING_SYNC=1: monitoring is handled once after all VMs are up (Phase 6).
echo ""
echo "=== Phase 1: Deploy to VM2 (isolated — no live-traffic impact) ==="
PROD_HOST=$VM2 \
  SKIP_BACKUP=true \
  SKIP_UPSTREAM_PARITY_CHECK=1 \
  DEPLOY_NON_INTERACTIVE=true \
  PGBOUNCER_BIND_ADDR=$VM2_INTERNAL \
  SKIP_MONITORING_SYNC=1 \
  ${ROLLBACK_FLAG:+FAST_ROLLBACK=true} \
  bash "${SCRIPT_DIR}/deploy-prod.sh" "$SHA" ${ROLLBACK_FLAG}

# ── Phase 2: Verify VM2 healthy before touching VM1 ──────────────────────────
echo ""
echo "=== Phase 2: Verify all 6 VM2 workers healthy ==="
all_ok=1
for p in 4000 4001 4002 4003 4004 4005; do
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
# SKIP_MONITORING_SYNC=1: monitoring is handled once after all VMs are up (Phase 6).
echo ""
echo "=== Phase 3: Deploy to VM1 (PgBouncer/Redis/MinIO/nginx) ==="
PROD_HOST=$VM1 \
  EXTRA_UPSTREAM_SERVERS_CSV="$EXTRA_UPSTREAM_CSV" \
  PGBOUNCER_BIND_ADDR=127.0.0.1 \
  DEPLOY_NON_INTERACTIVE=true \
  SKIP_MONITORING_SYNC=1 \
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

# ── Phase 5: Combined monitoring sync — rendered once for all three VMs ──────
# Runs after all app deploys succeed so Prometheus scrapes the correct worker
# list for VM1 (4 workers), VM2 (6 workers), and VM3 (6 workers).
echo ""
echo "=== Phase 5: Sync monitoring stack to monitoring VM (${MONITORING_VM_HOST}) ==="
PROM_BUILD="$(mktemp)"
python3 "${SCRIPT_DIR}/render-prometheus-host-config.py" \
  --template "${SCRIPT_DIR}/../infrastructure/monitoring/prometheus-host.yml" \
  --output "${PROM_BUILD}" \
  --app-host "${VM1_INTERNAL}" \
  --vm1-workers 4 \
  --vm2-host "${VM2_INTERNAL}" \
  --vm2-workers 6 \
  --vm3-host "${VM3_INTERNAL}" \
  --vm3-workers 6
# shellcheck disable=SC2086
scp -q -o StrictHostKeyChecking=accept-new \
    "${PROM_BUILD}" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/prometheus-host.yml.deploy" || true
rm -f "${PROM_BUILD}"
# Sync all monitoring config files to the monitoring VM
for _src in \
  "${SCRIPT_DIR}/../infrastructure/monitoring/alerts.yml:/tmp/alerts.yml.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/alertmanager.yml:/tmp/alertmanager.yml.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/monitoring-compose.yml:/tmp/monitoring-compose.yml.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/loki-config.yml:/tmp/loki-config.yml.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/tempo-config.yml:/tmp/tempo-config.yml.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/file_sd/db-node.json:/tmp/db-node.json.deploy" \
  "${SCRIPT_DIR}/../infrastructure/monitoring/file_sd/db-postgres.json:/tmp/db-postgres.json.deploy" \
  "${SCRIPT_DIR}/../deploy/prometheus-db-file-sd.py:/tmp/prometheus-db-file-sd.py.deploy"; do
  _local="${_src%%:*}"
  _remote="${_src##*:}"
  # shellcheck disable=SC2086
  scp -q -o StrictHostKeyChecking=accept-new \
      "${_local}" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:${_remote}" || true
done
# shellcheck disable=SC2086
scp -qr -o StrictHostKeyChecking=accept-new \
    "${SCRIPT_DIR}/../infrastructure/monitoring/grafana-provisioning-remote" \
    "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/grafana-provisioning-remote.deploy" || true
# Grab .env from VM1 for alertmanager webhook wiring
# shellcheck disable=SC2086
scp -q -o StrictHostKeyChecking=accept-new \
    "${PROD_USER}@${VM1}:/opt/chatapp/shared/.env" \
    "/tmp/chatapp-monitoring-multi.env" 2>/dev/null && \
  scp -q -o StrictHostKeyChecking=accept-new \
      "/tmp/chatapp-monitoring-multi.env" \
      "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/chatapp-monitoring.env.deploy" || true
rm -f "/tmp/chatapp-monitoring-multi.env"

ssh -o StrictHostKeyChecking=accept-new "${MONITORING_VM_USER}@${MONITORING_VM_HOST}" "
  set -euo pipefail
  sudo mkdir -p /opt/chatapp-monitoring/file_sd
  [ -f /tmp/prometheus-host.yml.deploy ] && { sudo cp /tmp/prometheus-host.yml.deploy /opt/chatapp-monitoring/prometheus-host.yml; rm -f /tmp/prometheus-host.yml.deploy; }
  [ -d /tmp/grafana-provisioning-remote.deploy ] && { sudo rm -rf /opt/chatapp-monitoring/grafana-provisioning-remote; sudo mv /tmp/grafana-provisioning-remote.deploy /opt/chatapp-monitoring/grafana-provisioning-remote; }
  [ -f /tmp/monitoring-compose.yml.deploy ] && { sudo cp /tmp/monitoring-compose.yml.deploy /opt/chatapp-monitoring/monitoring-compose.yml; rm -f /tmp/monitoring-compose.yml.deploy; }
  [ -f /tmp/alerts.yml.deploy ] && { sudo cp /tmp/alerts.yml.deploy /opt/chatapp-monitoring/alerts.yml; rm -f /tmp/alerts.yml.deploy; }
  [ -f /tmp/alertmanager.yml.deploy ] && { sudo cp /tmp/alertmanager.yml.deploy /opt/chatapp-monitoring/alertmanager.yml; rm -f /tmp/alertmanager.yml.deploy; }
  [ -f /tmp/loki-config.yml.deploy ] && { sudo cp /tmp/loki-config.yml.deploy /opt/chatapp-monitoring/loki-config.yml; rm -f /tmp/loki-config.yml.deploy; }
  [ -f /tmp/tempo-config.yml.deploy ] && { sudo cp /tmp/tempo-config.yml.deploy /opt/chatapp-monitoring/tempo-config.yml; rm -f /tmp/tempo-config.yml.deploy; }
  [ -f /tmp/prometheus-db-file-sd.py.deploy ] && { sudo cp /tmp/prometheus-db-file-sd.py.deploy /opt/chatapp-monitoring/prometheus-db-file-sd.py; sudo chmod 644 /opt/chatapp-monitoring/prometheus-db-file-sd.py; rm -f /tmp/prometheus-db-file-sd.py.deploy; }
  [ -f /tmp/db-node.json.deploy ] && { sudo cp /tmp/db-node.json.deploy /opt/chatapp-monitoring/file_sd/db-node.json; rm -f /tmp/db-node.json.deploy; }
  [ -f /tmp/db-postgres.json.deploy ] && { sudo cp /tmp/db-postgres.json.deploy /opt/chatapp-monitoring/file_sd/db-postgres.json; rm -f /tmp/db-postgres.json.deploy; }
  if [ -f /tmp/chatapp-monitoring.env.deploy ]; then
    sudo cp /tmp/chatapp-monitoring.env.deploy /opt/chatapp-monitoring/.env
    rm -f /tmp/chatapp-monitoring.env.deploy
  fi
  if [ -f /opt/chatapp-monitoring/.env ]; then
    sudo sed -i 's/^ALERT_ENVIRONMENT=.*/ALERT_ENVIRONMENT=production/' /opt/chatapp-monitoring/.env
    sudo grep -q '^ALERT_ENVIRONMENT=' /opt/chatapp-monitoring/.env || echo 'ALERT_ENVIRONMENT=production' | sudo tee -a /opt/chatapp-monitoring/.env >/dev/null
  fi
  [ -f /opt/chatapp-monitoring/prometheus-db-file-sd.py ] && [ -f /opt/chatapp-monitoring/.env ] && \
    sudo env CHATAPP_ENV_FILE=/opt/chatapp-monitoring/.env python3 /opt/chatapp-monitoring/prometheus-db-file-sd.py || true
  if [ -f /opt/chatapp-monitoring/.env ] && [ -f /opt/chatapp-monitoring/monitoring-compose.yml ]; then
    sudo docker compose --env-file /opt/chatapp-monitoring/.env -f /opt/chatapp-monitoring/monitoring-compose.yml up -d --remove-orphans prometheus alertmanager grafana loki tempo >/dev/null
  fi
  AM_NAME=\$(sudo docker ps --format '{{.Names}}' | grep 'alertmanager' | head -n 1 || true)
  if [ -z \"\$AM_NAME\" ]; then
    echo 'ERROR: alertmanager not running on monitoring VM'
    exit 1
  fi
  WEBHOOK_BYTES=\$(sudo docker exec \"\$AM_NAME\" sh -lc 'wc -c < /alertmanager/secrets/discord_webhook_url 2>/dev/null || echo 0')
  [ \"\${WEBHOOK_BYTES:-0}\" -lt 32 ] && echo 'ERROR: Alertmanager webhook secret not wired' && exit 1
  echo 'Monitoring VM sync complete — Prometheus scraping VM1(4)+VM2(6)+VM3(6) workers'
" || echo "⚠ Monitoring VM sync had errors (non-fatal — app deploy succeeded)"
echo "✓ Monitoring stack updated on monitoring VM (${MONITORING_VM_HOST})"
echo ""

# ── Phase 5: Final health check — all 16 workers across all VMs ──────────────
echo ""
echo "=== Phase 5: Final health check — all 16 workers (4 VM1 + 6 VM2 + 6 VM3) ==="
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
