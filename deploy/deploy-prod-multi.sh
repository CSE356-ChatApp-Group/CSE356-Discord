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
# Usage: bash deploy/deploy-prod-multi.sh <release-sha> [--rollback] [--dry-run] [--fast-stabilize] [--emergency]
#   --rollback         Pass through to all VM deploys (fast rollback mode)
#   --dry-run          Show what will be deployed without making changes
#   --fast-stabilize   Skip slow non-critical phases (DB SSH preflight + monitoring sync)
#   --emergency        Ultra-fast incident mode: skips extra safety phases, keeps only quick final checks
#
# Canary: set DEPLOY_STOP_AFTER_VM3=1 to run Phase -1 + Phase 0 + Phase 0.5 only, then exit
# (deploy VM3 workers, pause rollout, observe before VM2/VM1). Unset for a normal full rollout.
#
# Phase -1 (PostgreSQL max_connections) SSH to PROD_DB_HOST retries on transient failures
# (DB_SSH_PREFLIGHT_ATTEMPTS, DB_SSH_PREFLIGHT_INITIAL_SLEEP). Set SKIP_DB_SSH_PREFLIGHT=1 to bypass.
#
# Deploy without GitHub: ./scripts/release/package-release-artifact.sh then
#   LOCAL_ARTIFACT_PATH=$PWD/releases/chatapp-<sha>.tar.gz DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh <sha>
# SSH: PROD_USER defaults to ubuntu (DB + app hosts); override only if your hosts use another login.
#
# VM topology defaults: deploy/inventory-defaults.sh (override VM1/VM2/VM3 / *_INTERNAL).
# VM3 runs Node workers only; VM2 workers only; VM1 workers + PgBouncer + MinIO + nginx.

set -euo pipefail

DEPLOY_SUCCESS=0

SHA=${1:?Usage: deploy-prod-multi.sh <sha> [--rollback] [--dry-run] [--fast-stabilize] [--emergency]}
shift || true

ROLLBACK_FLAG=""
DRY_RUN=0
FAST_ROLLBACK_MODE="false"
FAST_STABILIZE_MODE="false"
EMERGENCY_MODE="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --rollback)
      ROLLBACK_FLAG="--rollback"
      FAST_ROLLBACK_MODE="true"
      ;;
    --fast-stabilize)
      FAST_STABILIZE_MODE="true"
      ;;
    --emergency)
      EMERGENCY_MODE="true"
      ;;
    *)
      echo "Usage: deploy-prod-multi.sh <sha> [--rollback] [--dry-run] [--fast-stabilize] [--emergency]"
      exit 1
      ;;
  esac
  shift
done

DEPLOY_ARGS=("${SHA}")
if [[ -n "${ROLLBACK_FLAG}" ]]; then
  DEPLOY_ARGS+=("${ROLLBACK_FLAG}")
fi
if [[ "${DRY_RUN}" -eq 1 && "${FAST_ROLLBACK_MODE}" == "true" ]]; then
  echo "WARNING: --dry-run with --rollback prints planned rollback flow only (no changes)."
fi
if [[ "${EMERGENCY_MODE}" == "true" ]]; then
  FAST_STABILIZE_MODE="true"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-phase-common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/deploy-phase-common.sh"
chatapp_validate_release_sha "${SHA}" || exit 1
# shellcheck source=inventory-defaults.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/inventory-defaults.sh"

VM1="${VM1:-${CHATAPP_INV_VM1_PUBLIC}}"
VM2="${VM2:-${CHATAPP_INV_VM2_PUBLIC}}"
VM3="${VM3:-${CHATAPP_INV_VM3_PUBLIC}}"
# VM1 app private IP (ens3). Do not use the DB VM (10.0.1.62) — Prometheus chatapp-api
# scrape targets must hit Node workers on this host or Grafana shows 12/16 "up".
VM1_INTERNAL="${VM1_INTERNAL:-${CHATAPP_INV_VM1_INTERNAL}}"
VM2_INTERNAL="${VM2_INTERNAL:-${CHATAPP_INV_VM2_INTERNAL}}"
VM3_INTERNAL="${VM3_INTERNAL:-${CHATAPP_INV_VM3_INTERNAL}}"
WSVM1="${WSVM1:-${CHATAPP_INV_WSVM1_PUBLIC}}"
WSVM2="${WSVM2:-${CHATAPP_INV_WSVM2_PUBLIC}}"
WSVM1_INTERNAL="${WSVM1_INTERNAL:-${CHATAPP_INV_WSVM1_INTERNAL}}"
WSVM2_INTERNAL="${WSVM2_INTERNAL:-${CHATAPP_INV_WSVM2_INTERNAL}}"
WSVM1_USER="${WSVM1_USER:-${CHATAPP_INV_WSVM1_USER}}"
WSVM2_USER="${WSVM2_USER:-${CHATAPP_INV_WSVM2_USER}}"
WSVM1_WORKERS="${WSVM1_WORKERS:-${CHATAPP_INV_WSVM1_WORKERS}}"
WSVM2_WORKERS="${WSVM2_WORKERS:-${CHATAPP_INV_WSVM2_WORKERS}}"
WS_TIER_ENABLED="${WS_TIER_ENABLED:-${CHATAPP_INV_WS_TIER_ENABLED}}"
if [[ "${CHATAPP_INV_WS_TIER_ENABLED}" == "true" ]] && [[ "${WS_TIER_ENABLED}" != "true" ]] && [[ "${ALLOW_WS_TIER_DISABLE:-0}" != "1" ]]; then
  echo "ERROR: inventory enables the dedicated websocket tier, but WS_TIER_ENABLED=${WS_TIER_ENABLED}." >&2
  echo "       Refusing to silently fall back to the shared websocket pool." >&2
  echo "       If you intentionally want to disable the ws tier for one deploy, rerun with ALLOW_WS_TIER_DISABLE=1." >&2
  exit 1
fi
DB_TARGET_MAX_CONNECTIONS="${DB_TARGET_MAX_CONNECTIONS:-450}"
VM1_PGBOUNCER_POOL_SIZE="${VM1_PGBOUNCER_POOL_SIZE:-90}"
VM2_PGBOUNCER_POOL_SIZE="${VM2_PGBOUNCER_POOL_SIZE:-135}"
VM3_PGBOUNCER_POOL_SIZE="${VM3_PGBOUNCER_POOL_SIZE:-135}"
VM1_PGBOUNCER_MAX_DB_CONNECTIONS="${VM1_PGBOUNCER_MAX_DB_CONNECTIONS:-100}"
VM2_PGBOUNCER_MAX_DB_CONNECTIONS="${VM2_PGBOUNCER_MAX_DB_CONNECTIONS:-145}"
VM3_PGBOUNCER_MAX_DB_CONNECTIONS="${VM3_PGBOUNCER_MAX_DB_CONNECTIONS:-145}"
VM1_PG_POOL_MAX_PER_INSTANCE="${VM1_PG_POOL_MAX_PER_INSTANCE:-25}"
VM2_PG_POOL_MAX_PER_INSTANCE="${VM2_PG_POOL_MAX_PER_INSTANCE:-25}"
VM3_PG_POOL_MAX_PER_INSTANCE="${VM3_PG_POOL_MAX_PER_INSTANCE:-25}"
PGBOUNCER_MIN_POOL_SIZE="${PGBOUNCER_MIN_POOL_SIZE:-5}"
PGBOUNCER_RESERVE_SIZE="${PGBOUNCER_RESERVE_SIZE:-5}"
PROD_USER="${PROD_USER:-ubuntu}"
MONITORING_VM_HOST="${MONITORING_VM_HOST:-${CHATAPP_INV_MONITORING_PUBLIC}}"
MONITORING_VM_USER="${MONITORING_VM_USER:-${PROD_USER}}"
MONITORING_VM_SCRAPE_SOURCE="${MONITORING_VM_SCRAPE_SOURCE:-${CHATAPP_INV_MONITORING_SCRAPE_SOURCE}}"
# Managed Redis is off-host (see docs/infrastructure-inventory.md). redis_exporter runs in Docker
# on an app VM with --network host; Prometheus on the monitoring VM scrapes :9121 on a *VPC*
# address. Do not SSH to a private IP from a laptop — use the public app host for SSH.
PROM_REDIS_HOST="${PROM_REDIS_HOST:-${VM1_INTERNAL}}"
REDIS_EXPORTER_SSH_HOST="${REDIS_EXPORTER_SSH_HOST:-$VM1}"
# VM1 runs fewer workers than VM2/VM3; deploy-prod.sh reads CHATAPP_INSTANCES from the target
# host's /opt/chatapp/shared/.env so systemd/nginx match (Phase 6 health checks use these lists).
VM1_WORKER_PORTS=(4000 4001 4002 4003)
VMX_WORKER_PORTS=(4000 4001 4002 4003 4004 4005)

build_ws_upstream_csv() {
  local upstreams=()
  local p
  if [[ "${WS_TIER_ENABLED}" == "true" ]] && [[ -n "${WSVM1_INTERNAL}" ]] && [[ "${WSVM1_WORKERS}" -gt 0 ]]; then
    for ((p=4000; p<4000 + WSVM1_WORKERS; p++)); do
      upstreams+=("${WSVM1_INTERNAL}:${p}")
    done
  fi
  if [[ "${WS_TIER_ENABLED}" == "true" ]] && [[ -n "${WSVM2_INTERNAL}" ]] && [[ "${WSVM2_WORKERS}" -gt 0 ]]; then
    for ((p=4000; p<4000 + WSVM2_WORKERS; p++)); do
      upstreams+=("${WSVM2_INTERNAL}:${p}")
    done
  fi
  if [[ "${WS_TIER_ENABLED}" == "true" ]]; then
    if [[ "${#upstreams[@]}" -eq 0 ]]; then
      echo "ERROR: websocket tier is enabled, but no dedicated websocket upstreams were built." >&2
      echo "       Check WSVM1/WSVM2 private IPs and worker counts in deploy/inventory-defaults.sh or deploy env." >&2
      return 1
    fi
  elif [[ "${#upstreams[@]}" -eq 0 ]]; then
    for p in "${VMX_WORKER_PORTS[@]}"; do
      upstreams+=("${VM2_INTERNAL}:${p}")
    done
    for p in "${VMX_WORKER_PORTS[@]}"; do
      upstreams+=("${VM3_INTERNAL}:${p}")
    done
  fi
  (IFS=,; echo "${upstreams[*]}")
}

if [[ "${WS_TIER_ENABLED}" == "true" ]]; then
  EXPECTED_DEDICATED_WS_CSV="$(build_ws_upstream_csv)" || exit 1
  echo "Using dedicated websocket upstreams: ${EXPECTED_DEDICATED_WS_CSV}"
fi

# Extra OpenSSH options — mirrors deploy-prod.sh default
DEPLOY_SSH_EXTRA_OPTS="${DEPLOY_SSH_EXTRA_OPTS:--o StrictHostKeyChecking=accept-new}"

# shellcheck source=deploy-common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-common.sh"
# shellcheck source=deploy-monitoring-shared.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-monitoring-shared.sh"

ssh_vm() {
  local host="$1"; shift
  # shellcheck disable=SC2086
  ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="/tmp/ssh-chatapp-multi-%r@${host}:%p" \
      -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${host}" "$@"
}

monitoring_host_user() {
  local host="${1:?host required}"
  case "${host}" in
    "${WSVM1}")
      printf '%s\n' "${WSVM1_USER}"
      ;;
    "${WSVM2}")
      printf '%s\n' "${WSVM2_USER}"
      ;;
    *)
      printf '%s\n' "${PROD_USER}"
      ;;
  esac
}

ssh_monitoring_host() {
  local host="${1:?host required}"
  shift
  local user
  user="$(monitoring_host_user "${host}")"
  # shellcheck disable=SC2086
  ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="/tmp/ssh-chatapp-multi-%r@${host}:%p" \
      -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${user}@${host}" "$@"
}

scp_to_monitoring_host() {
  local host="${1:?host required}"
  local local_path="${2:?local path required}"
  local remote_path="${3:?remote path required}"
  local user
  user="$(monitoring_host_user "${host}")"
  chatapp_scp_to_multi_vm "${host}" "${local_path}" "${user}@${host}:${remote_path}"
}

build_remote_upstream_csv() {
  local exclude_internal="${1:-}"
  local upstreams=()
  local p
  if [[ "${VM2_INTERNAL}" != "${exclude_internal}" ]]; then
    for p in "${VMX_WORKER_PORTS[@]}"; do
      upstreams+=("${VM2_INTERNAL}:${p}")
    done
  fi
  if [[ "${VM3_INTERNAL}" != "${exclude_internal}" ]]; then
    for p in "${VMX_WORKER_PORTS[@]}"; do
      upstreams+=("${VM3_INTERNAL}:${p}")
    done
  fi
  (IFS=,; echo "${upstreams[*]}")
}

rewrite_vm1_nginx_upstream() {
  local extra_upstream_csv="${1:-}"
  local ws_upstream_csv="${2:-}"
  local context="${3:-vm1 upstream rewrite}"
  if [[ -z "${ws_upstream_csv}" ]]; then
    ws_upstream_csv="$(build_ws_upstream_csv)"
  fi
  ssh_vm "$VM1" "
    set -euo pipefail
    export SITE=/etc/nginx/sites-enabled/chatapp
    export LOCAL_PORTS_CSV='$(IFS=,; echo "${VM1_WORKER_PORTS[*]}")'
    export EXTRA_UPSTREAM_SERVERS_CSV='${extra_upstream_csv}'
    export WS_EXTRA_UPSTREAM_SERVERS_CSV='${ws_upstream_csv}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    export TMP_SITE
    python3 <<'PY'
import os
import re

cfg_path = os.environ['TMP_SITE']
local_ports = [p.strip() for p in os.environ['LOCAL_PORTS_CSV'].split(',') if p.strip()]
extra_endpoints = [
    ep.strip()
    for ep in os.environ.get('EXTRA_UPSTREAM_SERVERS_CSV', '').split(',')
    if ep.strip()
]
servers = ''.join(f'  server localhost:{port} max_fails=0;\\n' for port in local_ports)
servers += ''.join(f'  server {ep} max_fails=0;\\n' for ep in extra_endpoints)
keepalive = (
    '  keepalive 256;\\n'
    + '  keepalive_requests 10000;\\n'
    + '  keepalive_timeout 75s;\\n'
)
dollar = chr(36)
map_block = (
    f'map {dollar}arg_token {dollar}ws_sticky_key ' + '{\\n'
    + '  default ' + f'{dollar}arg_token;\\n'
    + '  ""      ' + f'{dollar}binary_remote_addr;\\n'
    + '}\\n\\n'
)
http_block = (
    'upstream app {\\n'
    + servers
    + keepalive
    + '}'
)
ws_endpoints = [
    ep.strip()
    for ep in os.environ.get('WS_EXTRA_UPSTREAM_SERVERS_CSV', '').split(',')
    if ep.strip()
]
ws_servers = ''.join(f'  server {ep} max_fails=0;\\n' for ep in ws_endpoints)
if not ws_servers:
    ws_servers = ''.join(f'  server localhost:{port} max_fails=0;\\n' for port in local_ports)
ws_block = (
    'upstream app_ws {\\n'
    + f'  hash {dollar}ws_sticky_key consistent;\\n'
    + ws_servers
    + keepalive
    + '}'
)
text = open(cfg_path).read()
if 'ws_sticky_key' not in text:
    text, n_map = re.subn(r'(^\\s*upstream app \\{)', map_block + r'\\1', text, count=1, flags=re.MULTILINE)
    if n_map != 1:
        raise SystemExit(f'ws_sticky_key map missing and bootstrap insert failed (n={n_map})')
text, n = re.subn(r'upstream app \\{[^}]+\\}', http_block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit(f'upstream app block not replaced (n={n})')
text, n_ws = re.subn(r'upstream app_ws \\{[^}]+\\}', ws_block, text, count=1, flags=re.DOTALL)
if n_ws == 0:
    text, n_insert = re.subn(r'(upstream app \\{[^}]+\\}\\n+)', r'\\1' + ws_block + '\\n', text, count=1, flags=re.DOTALL)
    if n_insert != 1:
        raise SystemExit(f'upstream app_ws block missing and bootstrap insert failed (n={n_insert})')
elif n_ws != 1:
    raise SystemExit(f'upstream app_ws block not replaced (n={n_ws})')
open(cfg_path, 'w').write(text)
PY
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
  " || {
    echo "ERROR: ${context} failed."
    return 1
  }
}

drain_remote_vm_from_vm1_upstream() {
  local vm_label="$1"
  local vm_internal="$2"
  local remaining_csv
  local ws_csv
  remaining_csv="$(build_remote_upstream_csv "${vm_internal}")"
  ws_csv="$(build_ws_upstream_csv)"
  echo "=== Draining ${vm_label} remote workers from VM1 nginx upstream ==="
  rewrite_vm1_nginx_upstream "${remaining_csv}" "${ws_csv}" "drain ${vm_label} from VM1 nginx upstream"
  ssh_vm "$VM1" "
    set -euo pipefail
    SITE=/etc/nginx/sites-enabled/chatapp
    upstream_block=\$(sudo sed -n '/^upstream app {/,/^}/p' \"\$SITE\")
    if printf '%s\n' \"\$upstream_block\" | grep -q 'server ${vm_internal}:'; then
      echo 'ERROR: ${vm_label} upstream entries still present after drain'
      exit 1
    fi
  "
  echo "✓ ${vm_label} removed from VM1 nginx upstream"
}

restore_remote_vm_to_vm1_upstream() {
  local vm_label="$1"
  local vm_internal="$2"
  local full_csv
  local ws_csv
  full_csv="$(build_remote_upstream_csv)"
  ws_csv="$(build_ws_upstream_csv)"
  echo "=== Restoring ${vm_label} remote workers to VM1 nginx upstream ==="
  rewrite_vm1_nginx_upstream "${full_csv}" "${ws_csv}" "restore ${vm_label} to VM1 nginx upstream"
  ssh_vm "$VM1" "
    set -euo pipefail
    SITE=/etc/nginx/sites-enabled/chatapp
    upstream_block=\$(sudo sed -n '/^upstream app {/,/^}/p' \"\$SITE\")
    missing=0
    for port in ${VMX_WORKER_PORTS[*]}; do
      printf '%s\n' \"\$upstream_block\" | grep -q 'server ${vm_internal}:'\"\${port}\"' max_fails=0;' || missing=1
    done
    [ \"\$missing\" -eq 0 ]
  "
   echo "✓ ${vm_label} restored to VM1 nginx upstream"
}

cleanup_on_exit() {
  set +e
  if [[ "${DEPLOY_SUCCESS}" -ne 1 ]]; then
    echo ""
    echo "↩ Exit trap: deploy did not complete successfully — restoring full VM1 nginx upstream..."
    local full_csv
    local ws_csv
    full_csv="$(build_remote_upstream_csv 2>/dev/null)"
    ws_csv="$(build_ws_upstream_csv 2>/dev/null)"
    if [[ -z "${full_csv}" ]]; then
      echo "ERROR: failed to build full upstream CSV for restore"
      return
    fi
    if rewrite_vm1_nginx_upstream "${full_csv}" "${ws_csv}" "exit-trap: restore full upstream" 2>/dev/null; then
      echo "↩ Restored full upstream to VM1 nginx (VM2 + VM3 re-added)"
    else
      echo "ERROR: exit trap failed to restore VM1 nginx upstream — manual fix needed"
      echo "  Run on VM1: grep 'upstream app' /etc/nginx/sites-enabled/chatapp"
    fi
  fi
}
trap cleanup_on_exit EXIT

verify_and_heal_vm_workers() {
  local host="$1"
  local label="$2"
  local ports_csv="$3"
  echo "=== ${label}: verify/heal workers (${ports_csv}) ==="
  ssh_vm "$host" "
    set -euo pipefail
    IFS=',' read -r -a ports <<< '${ports_csv}'
    failures=0
    for p in \"\${ports[@]}\"; do
      unit=\"chatapp@\${p}.service\"
      healthy=0
      for attempt in 1 2 3; do
        active=0
        if systemctl is-active --quiet \"\$unit\"; then
          active=1
        fi
        body=\$(curl -fsS --max-time 8 \"http://127.0.0.1:\${p}/health\" 2>/dev/null || true)
        status=\$(printf '%s' \"\$body\" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(\"status\",\"\"))' 2>/dev/null || true)
        if [ \"\$active\" -eq 1 ] && [ \"\$status\" = \"ok\" ]; then
          healthy=1
          break
        fi
        echo \"  \${unit} unhealthy (attempt \${attempt}) - repairing\"
        sudo systemctl stop \"\$unit\" 2>/dev/null || true
        sudo systemctl kill --kill-who=all --signal=TERM \"\$unit\" 2>/dev/null || true
        sleep 0.5
        for _ in \$(seq 1 20); do
          if ! sudo ss -H -ltn \"sport = :\${p}\" | grep -q .; then
            break
          fi
          sleep 0.25
        done
        for pid in \$(sudo ss -H -ltnp \"sport = :\${p}\" | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | sort -u); do
          sudo kill -TERM \"\$pid\" 2>/dev/null || true
        done
        sleep 0.4
        for pid in \$(sudo ss -H -ltnp \"sport = :\${p}\" | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | sort -u); do
          sudo kill -9 \"\$pid\" 2>/dev/null || true
        done
        sudo systemctl reset-failed \"\$unit\" 2>/dev/null || true
        sudo systemctl start \"\$unit\"
        sleep 2
      done
      if [ \"\$healthy\" -ne 1 ]; then
        echo \"  \${unit}: DEAD\"
        sudo journalctl -u \"\$unit\" --no-pager -n 30 || true
        failures=1
      else
        echo \"  \${unit}: ok\"
      fi
    done
    [ \"\$failures\" -eq 0 ]
  "
}

push_monitoring_artifact() {
  local local_path="$1"
  local remote_path="$2"
  # shellcheck disable=SC2086
  scp -q -o StrictHostKeyChecking=accept-new \
      "${local_path}" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:${remote_path}" || true
}

run_vm_deploy() {
  local host="$1"
  local bind_addr="$2"
  local pgbouncer_pool="$3"
  local pgbouncer_max_db="$4"
  local pg_pool_max="$5"
  local extra_upstream_csv="${6:-}"
  local skip_upstream_parity="1"
  local skip_ingress_post_deploy="1"
  local local_ws_ports_csv=""
  local ws_extra_upstream_csv=""
  if [[ "${host}" == "${VM1}" ]]; then
    skip_upstream_parity=""
    skip_ingress_post_deploy=""
    ws_extra_upstream_csv="$(build_ws_upstream_csv)"
    if [[ "${WS_TIER_ENABLED}" == "true" ]]; then
      local_ws_ports_csv="__none__"
    fi
  fi

  PROD_HOST="$host" \
    PROM_REDIS_HOST="${PROM_REDIS_HOST}" \
    EXTRA_UPSTREAM_SERVERS_CSV="${extra_upstream_csv}" \
    LOCAL_WS_PORTS_CSV="${local_ws_ports_csv}" \
    WS_EXTRA_UPSTREAM_SERVERS_CSV="${ws_extra_upstream_csv}" \
    PGBOUNCER_POOL_SIZE="${pgbouncer_pool}" \
    PGBOUNCER_MAX_DB_CONNECTIONS="${pgbouncer_max_db}" \
    PGBOUNCER_MIN_POOL_SIZE="${PGBOUNCER_MIN_POOL_SIZE}" \
    PGBOUNCER_RESERVE_SIZE="${PGBOUNCER_RESERVE_SIZE}" \
    PG_POOL_MAX_PER_INSTANCE="${pg_pool_max}" \
    PG_MAX_CONNECTIONS="${DB_TARGET_MAX_CONNECTIONS}" \
    SKIP_BACKUP=true \
    SKIP_UPSTREAM_PARITY_CHECK="${skip_upstream_parity}" \
    ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT=false \
    DEPLOY_NON_INTERACTIVE=true \
    PGBOUNCER_BIND_ADDR="${bind_addr}" \
    SKIP_MONITORING_SYNC=1 \
    SKIP_INGRESS_POST_DEPLOY="${skip_ingress_post_deploy}" \
    FAST_ROLLBACK="${FAST_ROLLBACK_MODE}" \
    WS_TIER_ENABLED="${WS_TIER_ENABLED}" \
    WSVM1_INTERNAL="${WSVM1_INTERNAL}" \
    WSVM2_INTERNAL="${WSVM2_INTERNAL}" \
    WSVM1_WORKERS="${WSVM1_WORKERS}" \
    WSVM2_WORKERS="${WSVM2_WORKERS}" \
    bash "${SCRIPT_DIR}/deploy-prod.sh" "${DEPLOY_ARGS[@]}"
}

phase_deploy_workers_vm() {
  local phase_label="$1"
  local host="$2"
  local bind_addr="$3"
  local pgbouncer_pool="$4"
  local pgbouncer_max_db="$5"
  local pg_pool_max="$6"
  local upstream_csv="${7:-}"
  echo "${phase_label}"
  run_vm_deploy "$host" "$bind_addr" "$pgbouncer_pool" "$pgbouncer_max_db" "$pg_pool_max" "$upstream_csv"
}

phase_verify_workers_vm() {
  local phase_label="$1"
  local host="$2"
  local vm_label="$3"
  local ports_csv="$4"
  echo ""
  echo "${phase_label}"
  if ! verify_and_heal_vm_workers "$host" "$vm_label" "$ports_csv"; then
    return 1
  fi
  echo "✓ All ${vm_label} workers healthy"
}

emergency_quick_final_check() {
  echo ""
  echo "=== Emergency final sanity check (quick) ==="
  local ok=1
  for vm in "$VM1" "$VM2" "$VM3"; do
    local label="VM1"
    local expected=4
    if [ "$vm" = "$VM2" ]; then
      label="VM2"
      expected=6
    elif [ "$vm" = "$VM3" ]; then
      label="VM3"
      expected=6
    fi
    running=$(ssh_vm "$vm" "systemctl list-units 'chatapp@*.service' --state=running --no-legend | wc -l" 2>/dev/null || echo 0)
    echo "  ${label}: running=${running} expected=${expected}"
    if [ "${running}" -lt "${expected}" ]; then
      ok=0
    fi
  done
  return $ok
}

sync_monitoring_stack() {
  echo "=== Phase 5: Sync monitoring stack to monitoring VM (${MONITORING_VM_HOST}) ==="
  PROM_BUILD="$(mktemp)"
  deploy_render_prometheus_host_config \
    "${SCRIPT_DIR}/../infrastructure/monitoring/prometheus-host.yml" \
    "${PROM_BUILD}" \
    "${VM1_INTERNAL}" \
    "0" \
    "0" \
    "4" \
    "${VM2_INTERNAL}" \
    "6" \
    "${VM3_INTERNAL}" \
    "6" \
    "${PROM_REDIS_HOST}" \
    "${WSVM1_INTERNAL}" \
    "${WSVM1_WORKERS}" \
    "${WSVM2_INTERNAL}" \
    "${WSVM2_WORKERS}"
  # shellcheck disable=SC2086
  push_monitoring_artifact "${PROM_BUILD}" "/tmp/prometheus-host.yml.deploy"
  rm -f "${PROM_BUILD}"
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
    push_monitoring_artifact "${_local}" "${_remote}"
  done
  scp -qr -o StrictHostKeyChecking=accept-new \
      "${SCRIPT_DIR}/../infrastructure/monitoring/grafana-provisioning-remote" \
      "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/grafana-provisioning-remote.deploy" || true
  if scp -q -o BatchMode=yes -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new \
      "${PROD_USER}@${VM1}:/opt/chatapp/shared/.env" \
      "/tmp/chatapp-monitoring-multi.env" 2>/dev/null; then
    scp -q -o BatchMode=yes -o ConnectTimeout=25 -o StrictHostKeyChecking=accept-new \
        "/tmp/chatapp-monitoring-multi.env" \
        "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/chatapp-monitoring.env.deploy" || true
  fi
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
    if sudo docker ps --format '{{.Names}}' | grep -qx 'chatapp-monitoring-prometheus-1'; then
      if sudo docker restart chatapp-monitoring-prometheus-1 >/dev/null 2>&1; then
        echo 'Prometheus restarted on monitoring VM'
      else
        echo 'WARN: Prometheus restart failed on monitoring VM (non-fatal)'
      fi
    fi
    AM_NAME=\$(sudo docker ps --format '{{.Names}}' | grep 'alertmanager' | head -n 1 || true)
    if [ -z \"\$AM_NAME\" ]; then
      echo 'ERROR: alertmanager not running on monitoring VM'
      exit 1
    fi
    WEBHOOK_BYTES=\$(sudo docker exec \"\$AM_NAME\" sh -lc 'wc -c < /alertmanager/secrets/discord_webhook_url 2>/dev/null || echo 0')
    [ \"\${WEBHOOK_BYTES:-0}\" -lt 32 ] && echo 'ERROR: Alertmanager webhook secret not wired' && exit 1
    echo 'Monitoring VM sync complete - Prometheus scraping VM1(4)+VM2(6)+VM3(6)+WSVM1(6)+WSVM2(6) workers'
  " || echo "WARN: Monitoring VM sync had errors (non-fatal - app deploy succeeded)"
  echo "✓ Monitoring stack updated on monitoring VM (${MONITORING_VM_HOST})"
  echo ""
}

sync_monitoring_remote_host() {
  local host="${1:?host required}"
  local edge_enabled="${2:-0}"
  local ports_csv="${3:?ports csv required}"
  local label="${4:-${host}}"
  local compose_cmd
  compose_cmd="$(deploy_monitoring_remote_compose_up_cmd "/opt/chatapp-monitoring/remote-compose.yml" "${edge_enabled}")"

  ssh_monitoring_host "${host}" "
    set -euo pipefail
    IFS=',' read -r -a _ports <<< \"${ports_csv}\"
    for p in \"\${_ports[@]}\"; do
      if ! sudo ufw status | grep -qE \"^[[:space:]]*[0-9]+\\\\][[:space:]]+\${p}/tcp[[:space:]]+ALLOW IN[[:space:]]+${MONITORING_VM_SCRAPE_SOURCE}\"; then
        sudo ufw allow proto tcp from ${MONITORING_VM_SCRAPE_SOURCE} to any port \"\$p\" comment 'monitoring scrape' >/dev/null || true
      fi
    done
  " || echo "WARN: failed to apply UFW scrape rules on ${label}"

  scp_to_monitoring_host "${host}" "${SCRIPT_DIR}/../infrastructure/monitoring/remote-compose.yml" "/tmp/remote-compose.yml.deploy" || true
  scp_to_monitoring_host "${host}" "${SCRIPT_DIR}/../infrastructure/monitoring/promtail-host-config.yml" "/tmp/promtail-host-config.yml.deploy" || true
  scp_to_monitoring_host "${host}" "${SCRIPT_DIR}/../scripts/ops/synthetic-probe.sh" "/tmp/synthetic-probe.sh.deploy" || true
  scp_to_monitoring_host "${host}" "${SCRIPT_DIR}/pgbouncer-exporter.py" "/tmp/pgbouncer-exporter.py.deploy" || true

  ssh_monitoring_host "${host}" "
    set -euo pipefail
    if [ -f /tmp/remote-compose.yml.deploy ] || [ -f /tmp/promtail-host-config.yml.deploy ] || [ -f /tmp/synthetic-probe.sh.deploy ] || [ -f /tmp/pgbouncer-exporter.py.deploy ]; then
      sudo mkdir -p /opt/chatapp-monitoring
    fi
    sudo mkdir -p /opt/chatapp-monitoring/node_exporter_textfile
    sudo chown \$(id -un):\$(id -gn) /opt/chatapp-monitoring/node_exporter_textfile
    if [ -f /tmp/synthetic-probe.sh.deploy ]; then
      sudo install -m 755 /tmp/synthetic-probe.sh.deploy /opt/chatapp-monitoring/synthetic-probe.sh
      rm -f /tmp/synthetic-probe.sh.deploy
    fi
    if [ -x /opt/chatapp-monitoring/synthetic-probe.sh ]; then
      (
        crontab -l 2>/dev/null | grep -v '/opt/chatapp-monitoring/synthetic-probe.sh' || true
        echo '*/2 * * * * TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile CURL_MAX_TIME=12 /opt/chatapp-monitoring/synthetic-probe.sh >/dev/null 2>&1'
      ) | crontab -
    fi
    if [ -f /tmp/remote-compose.yml.deploy ]; then
      sudo cp /tmp/remote-compose.yml.deploy /opt/chatapp-monitoring/remote-compose.yml
      rm -f /tmp/remote-compose.yml.deploy
    fi
    if [ -f /tmp/promtail-host-config.yml.deploy ]; then
      sudo cp /tmp/promtail-host-config.yml.deploy /opt/chatapp-monitoring/promtail-host-config.yml
      rm -f /tmp/promtail-host-config.yml.deploy
    fi
    if [ -f /opt/chatapp-monitoring/remote-compose.yml ]; then
      ${compose_cmd} >/dev/null
    fi
    if [ -f /tmp/pgbouncer-exporter.py.deploy ]; then
      sudo install -m 755 /tmp/pgbouncer-exporter.py.deploy /opt/chatapp-monitoring/pgbouncer-exporter.py
      rm -f /tmp/pgbouncer-exporter.py.deploy
    fi
    if [ -f /opt/chatapp-monitoring/pgbouncer-exporter.py ]; then
      sudo tee /etc/systemd/system/pgbouncer-exporter.service > /dev/null <<'UNIT'
[Unit]
Description=PgBouncer Prometheus exporter
After=network.target pgbouncer.service
Wants=pgbouncer.service

[Service]
Type=simple
User=nobody
ExecStart=/usr/bin/python3 /opt/chatapp-monitoring/pgbouncer-exporter.py --listen 0.0.0.0:9126 --pgbouncer 127.0.0.1:6432
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
      sudo systemctl daemon-reload
      sudo systemctl enable pgbouncer-exporter 2>/dev/null || true
      sudo systemctl restart pgbouncer-exporter
    fi
  " || echo "WARN: monitoring host refresh failed on ${label}"
}

sync_monitoring_post_steps() {
  echo "Ensuring UFW scrape rules and host exporters on monitored VMs (source ${MONITORING_VM_SCRAPE_SOURCE})..."

  ports=("${VM1_WORKER_PORTS[@]}" 9100 9126 9113)
  if [ "${PROM_REDIS_HOST}" = "${VM1_INTERNAL}" ]; then
    ports+=(9121)
  fi
  ports_csv=$(IFS=,; echo "${ports[*]}")
  sync_monitoring_remote_host "${VM1}" "1" "${ports_csv}" "vm1"

  ports=("${VMX_WORKER_PORTS[@]}" 9100 9126)
  if [ "${PROM_REDIS_HOST}" = "${VM2_INTERNAL}" ]; then
    ports+=(9121)
  fi
  ports_csv=$(IFS=,; echo "${ports[*]}")
  sync_monitoring_remote_host "${VM2}" "0" "${ports_csv}" "vm2"

  ports=("${VMX_WORKER_PORTS[@]}" 9100 9126)
  if [ "${PROM_REDIS_HOST}" = "${VM3_INTERNAL}" ]; then
    ports+=(9121)
  fi
  ports_csv=$(IFS=,; echo "${ports[*]}")
  sync_monitoring_remote_host "${VM3}" "0" "${ports_csv}" "vm3"

  if [ -n "${WSVM1}" ] && [ -n "${WSVM1_INTERNAL}" ] && [ "${WSVM1_WORKERS}" -gt 0 ]; then
    ports=("${VMX_WORKER_PORTS[@]}" 9100 9126)
    ports_csv=$(IFS=,; echo "${ports[*]}")
    sync_monitoring_remote_host "${WSVM1}" "0" "${ports_csv}" "wsvm1"
  fi

  if [ -n "${WSVM2}" ] && [ -n "${WSVM2_INTERNAL}" ] && [ "${WSVM2_WORKERS}" -gt 0 ]; then
    ports=("${VMX_WORKER_PORTS[@]}" 9100 9126)
    ports_csv=$(IFS=,; echo "${ports[*]}")
    sync_monitoring_remote_host "${WSVM2}" "0" "${ports_csv}" "wsvm2"
  fi

  if [ "${PROM_REDIS_HOST}" != "${VM1_INTERNAL}" ]; then
    ssh_vm "$VM1" "sudo docker rm -f redis_exporter >/dev/null 2>&1 || true" || true
  fi
  if [ "${PROM_REDIS_HOST}" != "${VM2_INTERNAL}" ]; then
    ssh_vm "$VM2" "sudo docker rm -f redis_exporter >/dev/null 2>&1 || true" || true
  fi
  if [ "${PROM_REDIS_HOST}" != "${VM3_INTERNAL}" ]; then
    ssh_vm "$VM3" "sudo docker rm -f redis_exporter >/dev/null 2>&1 || true" || true
  fi

  echo "Starting redis_exporter via SSH ${REDIS_EXPORTER_SSH_HOST} (metrics at ${PROM_REDIS_HOST}:9121 for Prometheus)..."
  chatapp_scp_to_multi_vm "${REDIS_EXPORTER_SSH_HOST}" \
    "${SCRIPT_DIR}/redis_exporter_redis_url.py" \
    "${PROD_USER}@${REDIS_EXPORTER_SSH_HOST}:/tmp/redis_exporter_redis_url.py.deploy"
  # shellcheck disable=SC2086
  ssh -o StrictHostKeyChecking=accept-new \
      "${PROD_USER}@${REDIS_EXPORTER_SSH_HOST}" "
    set -euo pipefail
    sudo mkdir -p /opt/chatapp-monitoring
    sudo install -m 755 /tmp/redis_exporter_redis_url.py.deploy /opt/chatapp-monitoring/redis_exporter_redis_url.py
    rm -f /tmp/redis_exporter_redis_url.py.deploy
    RURL=\$(python3 /opt/chatapp-monitoring/redis_exporter_redis_url.py)
    ENVF=/opt/chatapp-monitoring/redis_exporter_runtime.env
    printf 'REDIS_ADDR=%s\\n' \"\$RURL\" | sudo tee \"\$ENVF\" >/dev/null
    sudo chmod 600 \"\$ENVF\"
    sudo docker rm -f redis_exporter >/dev/null 2>&1 || true
    sudo docker pull oliver006/redis_exporter:latest >/dev/null
    sudo docker run -d --name redis_exporter --restart unless-stopped --network host \\
      --env-file \"\$ENVF\" \\
      oliver006/redis_exporter:latest >/dev/null
    sudo rm -f \"\$ENVF\"
    echo 'redis_exporter (re)started (REDIS_ADDR from merged .env)'
  " || echo "⚠ Failed to start redis_exporter on ${REDIS_EXPORTER_SSH_HOST}"

  echo "Checking monitoring VM -> Redis exporter connectivity (${PROM_REDIS_HOST}:9121)..."
  ssh -o StrictHostKeyChecking=accept-new "${MONITORING_VM_USER}@${MONITORING_VM_HOST}" "
    if curl -fsS --max-time 8 http://${PROM_REDIS_HOST}:9121/metrics >/dev/null; then
      echo 'Monitoring connectivity to Redis exporter OK'
    else
      echo 'WARN: monitoring VM cannot reach ${PROM_REDIS_HOST}:9121 (check firewall/security groups)'
    fi
  " || true
}

run_preflight_db_check() {
  if [ "${SKIP_DB_SSH_PREFLIGHT:-}" = "1" ]; then
    echo "=== Phase -1: Pre-flight PostgreSQL check (skipped: SKIP_DB_SSH_PREFLIGHT=1) ==="
    echo "WARNING: not verifying PostgreSQL max_connections on DB host - use only when necessary."
    echo ""
    return 0
  fi
  echo "=== Phase -1: Pre-flight PostgreSQL check ==="
  echo "Verifying PostgreSQL max_connections is set for per-VM PgBouncer architecture..."
  PROD_DB_HOST="${PROD_DB_HOST:-130.245.136.21}"
  # GitHub runners sometimes see sshd close during KEX (MaxStartups / brief overload). Retry before failing the deploy.
  DB_SSH_PREFLIGHT_ATTEMPTS="${DB_SSH_PREFLIGHT_ATTEMPTS:-8}"
  DB_SSH_PREFLIGHT_INITIAL_SLEEP="${DB_SSH_PREFLIGHT_INITIAL_SLEEP:-2}"
  CURRENT_MAX=""
  SSH_EXIT=1
  delay="${DB_SSH_PREFLIGHT_INITIAL_SLEEP}"
  for attempt in $(seq 1 "${DB_SSH_PREFLIGHT_ATTEMPTS}"); do
    set +e
    # shellcheck disable=SC2086
    CURRENT_MAX=$(ssh -o BatchMode=yes -o ConnectTimeout=20 -o ConnectionAttempts=1 \
      ${DEPLOY_SSH_EXTRA_OPTS} "${PROD_USER}@${PROD_DB_HOST}" \
      "sudo -u postgres psql -qAt -c 'SHOW max_connections;' 2>/dev/null")
    SSH_EXIT=$?
    set -e
    if [ "${SSH_EXIT}" -eq 0 ]; then
      break
    fi
    if [ "${attempt}" -lt "${DB_SSH_PREFLIGHT_ATTEMPTS}" ]; then
      echo "WARN: SSH to DB ${PROD_DB_HOST} failed (exit ${SSH_EXIT}), attempt ${attempt}/${DB_SSH_PREFLIGHT_ATTEMPTS}; retrying in ${delay}s..."
      sleep "${delay}"
      # capped exponential backoff
      if [ "${delay}" -lt 30 ]; then
        delay=$(( delay * 2 ))
        [ "${delay}" -gt 30 ] && delay=30
      fi
    fi
  done
  if [ "${SSH_EXIT}" -ne 0 ]; then
    echo "ERROR: SSH connection to DB host ${PROD_DB_HOST} failed after ${DB_SSH_PREFLIGHT_ATTEMPTS} attempts (last exit code ${SSH_EXIT})."
    echo "Common causes: sshd rate limits (MaxStartups), fail2ban, transient load, or network flap from the runner."
    echo "Also verify ${PROD_DB_HOST} is reachable on port 22, DEPLOY_SSH_KEY is authorized, and SSH_KNOWN_HOSTS matches this host (see deploy/README.md)."
    exit 1
  fi
  if [ -z "${CURRENT_MAX}" ]; then
    echo "ERROR: PostgreSQL max_connections check returned empty output from ${PROD_DB_HOST}."
    exit 1
  fi
  echo "  Current PostgreSQL max_connections: ${CURRENT_MAX}"
  if [ "${CURRENT_MAX}" -lt "${DB_TARGET_MAX_CONNECTIONS}" ]; then
    echo "ERROR: PostgreSQL max_connections must be >= ${DB_TARGET_MAX_CONNECTIONS} for the staged pool-reduction rollout."
    echo "  Current: ${CURRENT_MAX}"
    echo "  Required: ${DB_TARGET_MAX_CONNECTIONS} (VM1 ${VM1_PGBOUNCER_MAX_DB_CONNECTIONS} + VM2 ${VM2_PGBOUNCER_MAX_DB_CONNECTIONS} + VM3 ${VM3_PGBOUNCER_MAX_DB_CONNECTIONS} + admin headroom)"
    echo ""
    echo "  Run on DB VM to upgrade:"
    echo "    DB_SSH=${PROD_USER}@${PROD_DB_HOST} REMOTE_PG_MAX_CONNECTIONS=${DB_TARGET_MAX_CONNECTIONS} ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh"
    echo ""
    exit 1
  fi
  echo "✓ PostgreSQL max_connections is adequate (${CURRENT_MAX})"
  echo ""
}

# Extra upstream servers to inject on every rewrite_nginx_upstream call during VM1 deploy.
# INCREASED from 5 to 6 workers per VM2/VM3 to utilize idle CPU capacity on those VMs.
# Validated: VM3 CPU idle ~76%, VM2 CPU idle ~48%. Adding 1 worker should use ~15% additional CPU.
EXTRA_UPSTREAMS=()
for p in "${VMX_WORKER_PORTS[@]}"; do
  EXTRA_UPSTREAMS+=("${VM2_INTERNAL}:${p}")
done
for p in "${VMX_WORKER_PORTS[@]}"; do
  EXTRA_UPSTREAMS+=("${VM3_INTERNAL}:${p}")
done
EXTRA_UPSTREAM_CSV=$(IFS=,; echo "${EXTRA_UPSTREAMS[*]}")

echo "======================================================================"
echo "=== Three-VM Production Deploy: ${SHA:0:12}                      ==="
echo "=== VM1 (nginx/PgBouncer/MinIO): ${VM1}            ==="
echo "=== VM2 (workers only):          ${VM2}           ==="
echo "=== VM3 (workers only):          ${VM3}            ==="
echo "======================================================================"
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "🏃 DRY RUN MODE - No changes will be made"
  echo ""
  echo "Expected Deployment Plan:"
  echo "  Release:      ${SHA:0:12} (from release-${SHA})"
  echo "  Phases:"
  echo "    Phase -1:  Pre-flight PostgreSQL check"
  echo "    Phase  0:  Drain VM3 from VM1 nginx, then deploy VM3 (6 workers: 4000-4005)"
  echo "    Phase 0.5: Verify VM3 workers, then rejoin VM3 to VM1 nginx"
  if [[ "${DEPLOY_STOP_AFTER_VM3:-}" == "1" ]]; then
    echo "    (CANARY) STOP after VM3 — DEPLOY_STOP_AFTER_VM3=1"
  fi
  echo "    Phase  1:  Drain VM2 from VM1 nginx, then deploy VM2 (6 workers: 4000-4005)"
  echo "    Phase  2:  Verify VM2 workers, then rejoin VM2 to VM1 nginx"
  echo "    Phase  3:  Deploy to VM1 (4 workers: 4000-4003)"
  if [[ "${EMERGENCY_MODE}" == "true" ]]; then
    echo "    Phase  4:  [SKIPPED] nginx upstream re-injection check (--emergency)"
  else
    echo "    Phase  4:  Verify nginx upstream entries"
  fi
  if [[ "${FAST_STABILIZE_MODE}" == "true" ]]; then
    echo "    Phase  5:  [SKIPPED] monitoring sync (--fast-stabilize)"
  else
    echo "    Phase  5:  Sync monitoring stack"
  fi
  if [[ "${EMERGENCY_MODE}" == "true" ]]; then
    echo "    Phase  6:  Emergency quick sanity check"
  else
    echo "    Phase  6:  Final health check (all 16 workers)"
  fi
  echo ""
  echo "Configuration:"
  echo "  VM1 PgBouncer pool_size/max_db_connections: ${VM1_PGBOUNCER_POOL_SIZE}/${VM1_PGBOUNCER_MAX_DB_CONNECTIONS}"
  echo "  VM2 PgBouncer pool_size/max_db_connections: ${VM2_PGBOUNCER_POOL_SIZE}/${VM2_PGBOUNCER_MAX_DB_CONNECTIONS}"
  echo "  VM3 PgBouncer pool_size/max_db_connections: ${VM3_PGBOUNCER_POOL_SIZE}/${VM3_PGBOUNCER_MAX_DB_CONNECTIONS}"
  echo "  PG_POOL_MAX per worker: VM1=${VM1_PG_POOL_MAX_PER_INSTANCE} VM2=${VM2_PG_POOL_MAX_PER_INSTANCE} VM3=${VM3_PG_POOL_MAX_PER_INSTANCE}"
  echo "  PostgreSQL needed: max_connections >= ${DB_TARGET_MAX_CONNECTIONS}"
  echo "  nginx upstream: 16 workers (4 VM1 + 6 VM2 + 6 VM3)"
  echo "  PROM_REDIS_HOST (Prometheus redis job): ${PROM_REDIS_HOST}"
  echo "  REDIS_EXPORTER_SSH_HOST (docker run target): ${REDIS_EXPORTER_SSH_HOST}"
  echo "  Fast stabilize mode: ${FAST_STABILIZE_MODE}"
  echo "  Emergency mode: ${EMERGENCY_MODE}"
  echo ""
  exit 0
fi
echo ""

if [[ "${FAST_STABILIZE_MODE}" == "true" ]]; then
  echo "Fast stabilize mode enabled: skipping DB SSH preflight and monitoring sync."
  SKIP_DB_SSH_PREFLIGHT=1
fi
if [[ "${EMERGENCY_MODE}" == "true" ]]; then
  echo "Emergency mode enabled: skipping intermediate verifies and upstream re-injection checks."
fi

# ── Phase -1: Pre-flight checks before any deploy ──────────────────────────────
# Set SKIP_DB_SSH_PREFLIGHT=1 only when the deploy host cannot SSH to the DB VM
# (e.g. missing known_hosts in CI); default is always verify max_connections.
run_preflight_db_check

# ── Phase 0: Drain VM3 from VM1 nginx, then deploy VM3 ───────────────────────
# VM3 has no shared services: a *failed* deploy does not take down Redis/PgBouncer on VM1.
# Remove VM3 from the shared VM1 nginx upstream before rolling its workers so
# POST traffic never targets a restarting remote peer.
drain_remote_vm_from_vm1_upstream "VM3" "${VM3_INTERNAL}"
phase_deploy_workers_vm \
  "=== Phase 0: Deploy to VM3 (workers only; drained from VM1 nginx during rollout) ===" \
  "$VM3" "$VM3_INTERNAL" "$VM3_PGBOUNCER_POOL_SIZE" "$VM3_PGBOUNCER_MAX_DB_CONNECTIONS" "$VM3_PG_POOL_MAX_PER_INSTANCE"

# ── Phase 0.5: Verify VM3 healthy, then rejoin it to VM1 nginx ──────────────
if [[ "${EMERGENCY_MODE}" != "true" ]] && ! phase_verify_workers_vm \
  "=== Phase 0.5: Verify all 6 VM3 workers healthy ===" \
  "$VM3" "VM3" "$(IFS=,; echo "${VMX_WORKER_PORTS[*]}")"; then
  echo "ERROR: One or more VM3 workers unhealthy — aborting before touching VM2/VM1."
  exit 1
fi
restore_remote_vm_to_vm1_upstream "VM3" "${VM3_INTERNAL}"

if [[ "${DEPLOY_STOP_AFTER_VM3:-}" == "1" ]]; then
  echo ""
  echo "======================================================================"
  echo "=== CANARY: DEPLOY_STOP_AFTER_VM3=1 - rollout paused here.        ==="
  echo "=== VM3 (${VM3}) runs the new build; VM1/VM2 unchanged.            ==="
  echo "=== Soak 10–15m; compare Prometheus vm=vm3 vs vm=~\"vm1|vm2\".      ==="
  echo "=== Resume: unset DEPLOY_STOP_AFTER_VM3 && ./deploy/deploy-prod-multi.sh ${SHA} ==="
  echo "======================================================================"
  exit 0
fi

# ── Phase 1: Drain VM2 from VM1 nginx, then deploy VM2 ───────────────────────
# Remove VM2 from the shared VM1 nginx upstream before rolling its workers so
# POST traffic never targets a restarting remote peer.
echo ""
drain_remote_vm_from_vm1_upstream "VM2" "${VM2_INTERNAL}"
phase_deploy_workers_vm \
  "=== Phase 1: Deploy to VM2 (workers only; drained from VM1 nginx during rollout) ===" \
  "$VM2" "$VM2_INTERNAL" "$VM2_PGBOUNCER_POOL_SIZE" "$VM2_PGBOUNCER_MAX_DB_CONNECTIONS" "$VM2_PG_POOL_MAX_PER_INSTANCE"

# ── Phase 2: Verify VM2 healthy, then rejoin it to VM1 nginx ─────────────────
if [[ "${EMERGENCY_MODE}" != "true" ]] && ! phase_verify_workers_vm \
  "=== Phase 2: Verify all 6 VM2 workers healthy ===" \
  "$VM2" "VM2" "$(IFS=,; echo "${VMX_WORKER_PORTS[*]}")"; then
  echo "ERROR: One or more VM2 workers unhealthy — aborting before touching VM1."
  echo "       VM1/VM3 are still on their previous releases."
  exit 1
fi
restore_remote_vm_to_vm1_upstream "VM2" "${VM2_INTERNAL}"

# ── Phase 3: Deploy to VM1 ───────────────────────────────────────────────────
# Pass EXTRA_UPSTREAM_SERVERS_CSV so rewrite_nginx_upstream preserves VM2/VM3 entries throughout
# the rolling restart.  SKIP_UPSTREAM_PARITY_CHECK is NOT set here — the gate runs
# normally and verifies VM1 localhost workers are active and in upstream.
# SKIP_MONITORING_SYNC=1: monitoring is handled once after all VMs are up (Phase 5).
echo ""
phase_deploy_workers_vm \
  "=== Phase 3: Deploy to VM1 (PgBouncer/MinIO/nginx) ===" \
  "$VM1" "127.0.0.1" "$VM1_PGBOUNCER_POOL_SIZE" "$VM1_PGBOUNCER_MAX_DB_CONNECTIONS" "$VM1_PG_POOL_MAX_PER_INSTANCE" "$EXTRA_UPSTREAM_CSV"

# ── Phase 4: Ensure VM2+VM3 upstream entries survived the VM1 deploy ─────────
# rewrite_nginx_upstream now preserves EXTRA_UPSTREAM_SERVERS_CSV entries, so this
# is a belt-and-suspenders check.  If entries are missing, re-inject with Python.
echo ""
if [[ "${EMERGENCY_MODE}" == "true" ]]; then
  echo "=== Phase 4: Upstream re-injection check skipped (--emergency) ==="
else
  echo "=== Phase 4: Verify / re-inject VM2+VM3 upstream entries ==="
  ssh_vm "$VM1" "
  set -euo pipefail
  SITE=/etc/nginx/sites-enabled/chatapp
  EXPECTED_HTTP_UPSTREAM_CSV='${EXTRA_UPSTREAM_CSV}'
  EXPECTED_WS_UPSTREAM_CSV='$(build_ws_upstream_csv)'
  missing=0
  http_block=\$(sudo sed -n '/^upstream app {/,/^}/p' \"\$SITE\")
  IFS=',' read -r -a expected_http_upstreams <<< \"\$EXPECTED_HTTP_UPSTREAM_CSV\"
  for endpoint in \"\${expected_http_upstreams[@]}\"; do
    printf '%s\n' \"\$http_block\" | grep -q \"server \${endpoint} \" || missing=1
  done
  ws_missing=0
  IFS=',' read -r -a expected_ws_upstreams <<< \"\$EXPECTED_WS_UPSTREAM_CSV\"
  ws_block=\$(sudo sed -n '/^upstream app_ws {/,/^}/p' \"\$SITE\")
  for endpoint in \"\${expected_ws_upstreams[@]}\"; do
    printf '%s\n' \"\$ws_block\" | grep -q \"server \${endpoint} \" || ws_missing=1
  done
  if [ \"\$missing\" = \"0\" ] && [ \"\$ws_missing\" = \"0\" ]; then
    echo 'VM2+VM3 upstream entries intact for HTTP + WS - no action needed'
    exit 0
  fi
  echo 'Upstream entries missing - re-injecting...'
  TMP=\$(mktemp)
  cp \"\$SITE\" \"\$TMP\"
  EXPECTED_HTTP_UPSTREAM_CSV=\"\$EXPECTED_HTTP_UPSTREAM_CSV\" EXPECTED_WS_UPSTREAM_CSV=\"\$EXPECTED_WS_UPSTREAM_CSV\" TMP_SITE=\"\$TMP\" python3 - <<'PY'
import os
import re
from pathlib import Path

site = Path(os.environ['TMP_SITE'])
text = site.read_text()
dollar = chr(36)
if 'ws_sticky_key' not in text:
    map_block = (
        f'map {dollar}arg_token {dollar}ws_sticky_key ' + '{\n'
        + '  default ' + f'{dollar}arg_token;\n'
        + '  ""      ' + f'{dollar}binary_remote_addr;\n'
        + '}\n\n'
    )
    text, n_map = re.subn(r'(^\s*upstream app \{)', map_block + r'\1', text, count=1, flags=re.MULTILINE)
    if n_map != 1:
        raise SystemExit('ws_sticky_key map missing and bootstrap insert failed')

expected_http = [
    endpoint.strip()
    for endpoint in os.environ['EXPECTED_HTTP_UPSTREAM_CSV'].split(',')
    if endpoint.strip()
]
expected_ws = [
    endpoint.strip()
    for endpoint in os.environ['EXPECTED_WS_UPSTREAM_CSV'].split(',')
    if endpoint.strip()
]
http_extra_servers = ''.join(
    f'  server {endpoint} max_fails=0;\\n'
    for endpoint in expected_http
)
ws_extra_servers = ''.join(
    f'  server {endpoint} max_fails=0;\\n'
    for endpoint in expected_ws
)

def inject(m):
    block = m.group(0)
    if all(endpoint in block for endpoint in expected_http):
        return block
    return re.sub(r'(  keepalive \d+;)', http_extra_servers + r'\1', block, count=1)

text, n = re.subn(r'upstream app \{[^}]+\}', inject, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('upstream app block not found')
def replace_ws(m):
    block = m.group(0)
    keepalive = re.search(r'(  keepalive \d+;\n  keepalive_requests \d+;\n  keepalive_timeout [^;]+;\n)', block)
    keepalive_text = keepalive.group(1) if keepalive else '  keepalive 256;\\n  keepalive_requests 10000;\\n  keepalive_timeout 75s;\\n'
    return f'upstream app_ws {{\\n  hash {dollar}ws_sticky_key consistent;\\n' + ws_extra_servers + keepalive_text + '}'
text, n_ws = re.subn(r'upstream app_ws \{[^}]+\}', replace_ws, text, count=1, flags=re.DOTALL)
if n_ws == 0:
    ws_block = replace_ws(type('Match', (), {'group': lambda self, _idx=0: ''})())
    text, n_insert = re.subn(r'(upstream app \{[^}]+\}\n+)', r'\1' + ws_block + '\n', text, count=1, flags=re.DOTALL)
    if n_insert != 1:
        raise SystemExit('upstream app_ws block not found and bootstrap insert failed')
elif n_ws != 1:
    raise SystemExit('upstream app_ws block not found')
site.write_text(text)
PY
  sudo install -m 644 \"\$TMP\" \"\$SITE\"
  rm -f \"\$TMP\"
  sudo nginx -t && sudo systemctl reload nginx
  echo 'VM2+VM3 upstream entries re-injected and nginx reloaded'
"
fi

# ── Phase 5: Combined monitoring sync — rendered once for all three VMs ──────
# Runs after all app deploys succeed so Prometheus scrapes the correct worker
# list for VM1 (4 workers), VM2 (6 workers), and VM3 (6 workers).
echo ""
if [[ "${FAST_STABILIZE_MODE}" == "true" ]]; then
  echo "=== Phase 5: Monitoring sync skipped (--fast-stabilize) ==="
  echo "Run full deploy script without --fast-stabilize once incident is stable."
else
  sync_monitoring_stack
  sync_monitoring_post_steps
fi

# ── Phase 6: Final health check — all 16 workers across all VMs ──────────────
echo ""
overall_ok=1
if [[ "${EMERGENCY_MODE}" == "true" ]]; then
  emergency_quick_final_check || overall_ok=0
else
  echo "=== Phase 6: Final health check — all 16 workers (4 VM1 + 6 VM2 + 6 VM3) ==="
  verify_and_heal_vm_workers "$VM1" "VM1" "$(IFS=,; echo "${VM1_WORKER_PORTS[*]}")" || overall_ok=0
  verify_and_heal_vm_workers "$VM2" "VM2" "$(IFS=,; echo "${VMX_WORKER_PORTS[*]}")" || overall_ok=0
  verify_and_heal_vm_workers "$VM3" "VM3" "$(IFS=,; echo "${VMX_WORKER_PORTS[*]}")" || overall_ok=0
fi

echo ""
if [ "$overall_ok" -eq 1 ]; then
  DEPLOY_SUCCESS=1
  echo "======================================================================"
  echo "=== Deploy complete: ${SHA:0:12} live on all three VMs          ==="
  echo "======================================================================"
else
  echo "WARNING: One or more workers may be degraded - check output above."
  exit 1
fi
