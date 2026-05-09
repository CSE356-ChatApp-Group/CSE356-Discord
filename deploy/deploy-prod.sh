#!/bin/bash
# deploy/deploy-prod.sh
# Deploy to production using candidate-port cutover.
# Usage: ./deploy-prod.sh <release-sha> [--rollback]
#
# Maintainability: default hosts live in inventory-defaults.sh; nginx upstream / gates /
# worker rolling helpers in deploy-prod-rolling.sh; nginx Python patches in
# deploy-prod-nginx-patches.sh; pool sizing in deploy-prod-remote-sizing.sh;
# background monitoring refresh in deploy-prod-monitoring-sync.sh.
#
# Robustness: preflight runs before sizing SSH fan-out; RELEASE_SHA is hex-only; ssh_prod
# uses BatchMode + ConnectTimeout; after confirm we take a remote deploy lock and register
# EXIT cleanup (lock release + optional rollback when nginx candidate pin is active).
#
# Avoid GitHub at deploy time (no gh / rate limits): build a tarball that matches CI
# (see scripts/release/package-release-artifact.sh), then:
#   LOCAL_ARTIFACT_PATH=/abs/path/to/releases/chatapp-<sha>.tar.gz ./deploy-prod.sh <sha>
#
# Flags:
#   --rollback     Fast rollback to <release-sha> (already on server). Skips backup,
#                  artifact download/unpack, migrations, pgbouncer, monitoring.
#                  Completes in ~2-3 min.  Use when the current deploy is bad and you
#                  need to revert quickly.
#   SKIP_BACKUP=true  Skip pg_dump (safe for code-only deploys, saves 2-5 min).

set -euo pipefail

if [[ -z "${DEPLOY_SSH_TMPDIR:-}" ]]; then
  DEPLOY_SSH_TMPDIR="$(mktemp -d)"
  _DEPLOY_SSH_TMPDIR_OWNED=1
else
  mkdir -p "${DEPLOY_SSH_TMPDIR}"
  _DEPLOY_SSH_TMPDIR_OWNED=0
fi
_cleanup_deploy_ssh_tmpdir() {
  if [[ "${_DEPLOY_SSH_TMPDIR_OWNED:-0}" == "1" ]]; then
    rm -rf "${DEPLOY_SSH_TMPDIR}"
  fi
}
trap _cleanup_deploy_ssh_tmpdir EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-phase-common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/deploy-phase-common.sh"

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy-prod.sh <sha> [--rollback]}
# Refuse odd SHAs early so they never reach unquoted remote snippets.
chatapp_validate_release_sha "${RELEASE_SHA}" || exit 1
# --rollback flag: skip artifact download, backup, artifact unpack, migrations, pgbouncer setup,
# and monitoring refresh — only do the rolling restart + health gates.
FAST_ROLLBACK="${FAST_ROLLBACK:-false}"
if [[ "${2:-}" == "--rollback" ]]; then
  FAST_ROLLBACK="true"
fi
# shellcheck source=inventory-defaults.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/inventory-defaults.sh"

PROD_HOST="${PROD_HOST:-${CHATAPP_INV_VM1_PUBLIC}}"
PROD_DB_HOST="${PROD_DB_HOST:-${CHATAPP_INV_DB_HOST}}"
PROD_USER="${PROD_USER:-ubuntu}"
# Monitoring VM hosts the full observability stack (Grafana/Prometheus/Alertmanager/Loki/Tempo).
# Set SKIP_MONITORING_SYNC=1 to suppress the monitoring refresh (used by deploy-prod-multi.sh
# which handles monitoring as a single combined step after all VMs are deployed).
MONITORING_VM_HOST="${MONITORING_VM_HOST:-${CHATAPP_INV_MONITORING_PUBLIC}}"
MONITORING_VM_USER="${MONITORING_VM_USER:-${PROD_USER}}"
SKIP_MONITORING_SYNC="${SKIP_MONITORING_SYNC:-0}"
# Multi-VM Prometheus params: set by deploy-prod-multi.sh to render all-VM scrape config.
PROM_VM1_WORKERS="${PROM_VM1_WORKERS:-0}"
PROM_VM2_HOST="${PROM_VM2_HOST:-}"
PROM_VM2_WORKERS="${PROM_VM2_WORKERS:-0}"
PROM_VM3_HOST="${PROM_VM3_HOST:-}"
PROM_VM3_WORKERS="${PROM_VM3_WORKERS:-0}"
GITHUB_REPO="${GITHUB_REPO:-CSE356-ChatApp-Group/CSE356-Discord}"
LOCAL_ARTIFACT_PATH="${LOCAL_ARTIFACT_PATH:-}"
RELEASE_DIR="/opt/chatapp/releases"
CURRENT_LINK="/opt/chatapp/current"
# Set before remote artifact download (step 3); cleanup_on_exit removes stale tarballs.
DOWNLOAD_PATH=""
_cleanup_download_path() {
  [[ -n "${DOWNLOAD_PATH:-}" ]] || return 0
  rm -f "${DOWNLOAD_PATH}" 2>/dev/null || true
}
OLD_PORT=4000
NEW_PORT=4001
# shellcheck source=deploy-common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-common.sh"
# shellcheck source=rollback.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/rollback.sh"

ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT="${ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT:-true}"

# Extra OpenSSH client options for every prod ssh/scp (monitoring uses raw scp and must match).
# Default accept-new: first connect records the key; later connects verify (survives VM reprovision
# better than strict yes). For strict CI: DEPLOY_SSH_EXTRA_OPTS='-o StrictHostKeyChecking=yes'
# after pre-populating known_hosts. To fix a one-off mismatch: ssh-keygen -R "${PROD_HOST}" etc.
DEPLOY_SSH_EXTRA_OPTS="${DEPLOY_SSH_EXTRA_OPTS:--o StrictHostKeyChecking=accept-new}"

ssh_prod() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=25 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="${DEPLOY_SSH_TMPDIR}/ssh-%r@%h:%p" -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${PROD_HOST}" "$@"
}

ssh_prod_db() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=25 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="${DEPLOY_SSH_TMPDIR}/ssh-%r@%h:%p" -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${PROD_DB_HOST}" "$@"
}

ssh_monitor() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=25 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath="${DEPLOY_SSH_TMPDIR}/ssh-%r@%h:%p" -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${MONITORING_VM_USER}@${MONITORING_VM_HOST}" "$@"
}

# shellcheck source=deploy-prod-nginx-patches.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-nginx-patches.sh"

# Send a Discord notification to the prod ops webhook (DISCORD_WEBHOOK_URL_PROD env var).
# Silently skips if the variable is unset or curl fails — never blocks the deploy.
notify_discord_prod() {
  local msg="$1"
  local webhook="${DISCORD_WEBHOOK_URL_PROD:-}"
  if [[ -z "$webhook" ]]; then
    return 0
  fi
  curl -fsS -m 10 -X POST "$webhook" \
    -H 'Content-Type: application/json' \
    -d "{\"content\": $(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    >/dev/null 2>&1 || true
}

run_local_prod_nginx_audit() {
  if [ ! -x "${SCRIPT_DIR}/../scripts/ops/prod-nginx-audit.sh" ]; then
    echo "WARN: prod-nginx-audit.sh not found or not executable; skipping local audit."
    return 0
  fi
  PROD_HOST="${PROD_HOST}" PROD_USER="${PROD_USER}" "${SCRIPT_DIR}/../scripts/ops/prod-nginx-audit.sh"
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT
  set +e
  _cleanup_download_path
  if [ "${status}" -ne 0 ] && [[ -n "${_MONITORING_BG_PID:-}" ]] && kill -0 "${_MONITORING_BG_PID}" 2>/dev/null; then
    echo "Stopping background monitoring refresh after deploy failure..."
    kill "${_MONITORING_BG_PID}" 2>/dev/null || true
    wait "${_MONITORING_BG_PID}" 2>/dev/null || true
  fi
  if [ "${status}" -ne 0 ] && [ "${NGINX_CANDIDATE_PIN_ACTIVE:-0}" -eq 1 ] && [ "${ROLLBACK_ALREADY_ATTEMPTED:-0}" -eq 0 ]; then
    ROLLBACK_ALREADY_ATTEMPTED=1
    echo "↩ Exit trap: deploy failed after nginx was pinned to candidate; attempting recovery..."
    notify_discord_prod ":x: **Prod deploy FAILED** \`${RELEASE_SHA:0:7}\` - rollback triggered"
    rollback_cutover
  elif [ "${status}" -ne 0 ]; then
    notify_discord_prod ":x: **Prod deploy FAILED** \`${RELEASE_SHA:0:7}\` (pre-cutover)"
  fi
  release_remote_deploy_lock
  # Only remove a directory this process created. Parallel deploy-prod children
  # (deploy-prod-multi) may share a caller-provided DEPLOY_SSH_TMPDIR — never
  # delete it or a sibling's SSH control sockets break mid-flight.
  if [[ "${_DEPLOY_SSH_TMPDIR_OWNED:-0}" == "1" ]]; then
    rm -rf "${DEPLOY_SSH_TMPDIR}"
  fi
  exit "${status}"
}

deploy_prod_cancel_monitoring_refresh() {
  if [[ -n "${_MONITORING_BG_PID:-}" ]] && kill -0 "${_MONITORING_BG_PID}" 2>/dev/null; then
    echo "Stopping background monitoring refresh before rollback..."
    kill "${_MONITORING_BG_PID}" 2>/dev/null || true
    wait "${_MONITORING_BG_PID}" 2>/dev/null || true
  fi
}

deploy_prod_wait_monitoring_refresh_nonfatal() {
  local code
  if [[ -n "${_MONITORING_BG_PID:-}" ]]; then
    echo "Waiting for background monitoring refresh to complete..."
    set +e
    wait "${_MONITORING_BG_PID}"
    code=$?
    set -e
    if [[ "${code}" -ne 0 ]]; then
      echo "WARN: monitoring refresh failed (non-fatal) with exit code ${code}"
    fi
    _MONITORING_BG_PID=""
  fi
}

DEPLOY_LOCK_DIR="/opt/chatapp/.deploy-lock-prod"
DEPLOY_LOCK_TTL_SECS="${DEPLOY_LOCK_TTL_SECS:-3600}"

acquire_remote_deploy_lock() {
  ssh_prod "
    set -euo pipefail
    lock='${DEPLOY_LOCK_DIR}'
    ttl='${DEPLOY_LOCK_TTL_SECS}'
    now=\$(date +%s)
    stale=0
    if [ -f \"\$lock/started_at\" ]; then
      started=\$(cat \"\$lock/started_at\" 2>/dev/null || echo 0)
      if [ \"\$started\" -gt 0 ] && [ \$((now - started)) -gt \"\$ttl\" ]; then
        stale=1
      fi
    fi
    if mkdir \"\$lock\" 2>/dev/null; then
      :
    elif [ \"\$stale\" -eq 1 ]; then
      echo \"WARN: removing stale prod deploy lock (older than \${ttl}s)\"
      rm -rf \"\$lock\"
      mkdir \"\$lock\"
    else
      owner=\$(cat \"\$lock/owner\" 2>/dev/null || echo unknown)
      started=\$(cat \"\$lock/started_at_iso\" 2>/dev/null || echo unknown)
      sha=\$(cat \"\$lock/release_sha\" 2>/dev/null || echo unknown)
      age=\$(( now - \$(cat \"\$lock/started_at\" 2>/dev/null || echo \$now) ))
      echo \"\" >&2
      echo \"ERROR: prod deploy lock is held\" >&2
      echo \"  owner      : \$owner\" >&2
      echo \"  release_sha: \$sha\" >&2
      echo \"  started_at : \$started\" >&2
      echo \"  age        : \${age}s (TTL=${DEPLOY_LOCK_TTL_SECS}s)\" >&2
      echo \"\" >&2
      echo \"To clear: rm -rf \$lock   (only if the owning deploy has finished or died)\" >&2
      exit 42
    fi
    echo '${RELEASE_SHA}' > \"\$lock/release_sha\"
    echo \"\$(hostname)-\$\$\" > \"\$lock/owner\"
    date +%s > \"\$lock/started_at\"
    date -u +%Y-%m-%dT%H:%M:%SZ > \"\$lock/started_at_iso\"
  "
}

release_remote_deploy_lock() {
  ssh_prod "rm -rf '${DEPLOY_LOCK_DIR}'" >/dev/null 2>&1 || true
}

# Print lock state without acquiring it; exit 0=free, 1=held, 2=stale.
diagnose_remote_deploy_lock() {
  ssh_prod "
    set -euo pipefail
    lock='${DEPLOY_LOCK_DIR}'
    ttl='${DEPLOY_LOCK_TTL_SECS}'
    now=\$(date +%s)
    if [ ! -d \"\$lock\" ]; then
      echo 'Lock: free'
      exit 0
    fi
    owner=\$(cat \"\$lock/owner\" 2>/dev/null || echo unknown)
    sha=\$(cat \"\$lock/release_sha\" 2>/dev/null || echo unknown)
    started=\$(cat \"\$lock/started_at_iso\" 2>/dev/null || echo unknown)
    age=\$(( now - \$(cat \"\$lock/started_at\" 2>/dev/null || echo \$now) ))
    if [ \$age -gt \$ttl ]; then
      echo \"Lock: STALE (age=\${age}s > TTL=\${ttl}s) owner=\$owner sha=\$sha started=\$started\"
      exit 2
    fi
    echo \"Lock: held  owner=\$owner sha=\$sha started=\$started age=\${age}s\"
    exit 1
  " 2>&1 || true
}

MONITOR_SECONDS="${MONITOR_SECONDS:-0}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
NGINX_WORKER_CONNECTIONS="${NGINX_WORKER_CONNECTIONS:-16384}"
ALLOW_DB_RESTART="${ALLOW_DB_RESTART:-false}"
RECLAIM_OLD_PORT="${RECLAIM_OLD_PORT:-false}"
# Dual-worker: pin nginx to the candidate port before restarting the companion (9a).
# Default true — nginx otherwise may pick the restarting peer for POST; without
# `non_idempotent` on proxy_next_upstream, POST is not retried and clients see 502 HTML.
PIN_CANDIDATE_BEFORE_COMPANION="${PIN_CANDIDATE_BEFORE_COMPANION:-true}"
INGRESS_CANARY_SECONDS="${INGRESS_CANARY_SECONDS:-45}"
ALL_WORKER_HEALTH_PASSES="${ALL_WORKER_HEALTH_PASSES:-3}"
# Maximum seconds to wait after a worker passes health before rolling the next one.
# The rolling helper exits early after 3 consecutive /health OK responses.
# Gives WebSocket clients time to reconnect + replay before the next worker is taken down.
# 8s: matches WS_APP_KEEPALIVE_INTERVAL_MS so all clients reconnect within one keepalive cycle.
# (Was 15s — reduced to shave ~20s off a 5-worker rolling deploy.)
WORKER_SETTLE_SECS="${WORKER_SETTLE_SECS:-10}"
# Nginx reloads are graceful: old worker processes can keep serving existing
# keepalive clients with the previous upstream list until worker_shutdown_timeout.
# Wait before stopping a removed worker so old nginx workers cannot route to a
# port that has already been restarted.
NGINX_RELOAD_DRAIN_SECS="${NGINX_RELOAD_DRAIN_SECS:-20}"
# PgBouncer helper scripts: never scp to /tmp — root-owned leftovers from manual
# `sudo` runs cause "Permission denied" for the deploy user (ubuntu).
DEPLOY_REMOTE_HELPER_DIR="${DEPLOY_REMOTE_HELPER_DIR:-chatapp-deploy-helpers}"

if [[ -z "${PROD_HOST}" || -z "${PROD_DB_HOST}" ]]; then
  echo "ERROR: PROD_HOST and PROD_DB_HOST must be non-empty (see deploy/inventory-defaults.sh or set env)."
  exit 1
fi
if [[ "${SKIP_MONITORING_SYNC:-0}" != "1" && -z "${MONITORING_VM_HOST}" ]]; then
  echo "ERROR: MONITORING_VM_HOST must be set when monitoring sync runs (set SKIP_MONITORING_SYNC=1 to skip)."
  exit 1
fi

_DEPLOY_T0=$(date +%s)
deploy_log_phase() {
  local now
  now=$(date +%s)
  printf '%s deploy +%ss: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((now - _DEPLOY_T0))" "$1"
}

# Connectivity + remote prerequisites before any CHATAPP_INSTANCES / sizing SSH fan-out.
# Fast rollback uses /opt/chatapp/releases/<sha> already on the host; older SHAs may not
# have a matching GitHub release tag from this laptop, so skip the gh release gate.
if [[ "${FAST_ROLLBACK}" == "true" ]]; then
  export SKIP_GH_RELEASE_PREFLIGHT=1
fi
"${SCRIPT_DIR}/preflight-check.sh" prod "$RELEASE_SHA" "$PROD_USER" "$PROD_HOST" "$GITHUB_REPO"
deploy_log_phase "preflight OK"
if [ "${ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT}" = "true" ]; then
  echo "Running prod nginx parity audit before deploy..."
  run_local_prod_nginx_audit
  echo "✓ Prod nginx parity audit passed"
else
  echo "WARN: skipping prod nginx parity audit preflight (ENFORCE_PROD_NGINX_AUDIT_PREFLIGHT=false)"
fi

# Number of Node.js HTTP workers (systemd chatapp@ ports).
# Prefer the value persisted on the deploy target in /opt/chatapp/shared/.env so VM1 can run
# 4 workers (no chatapp@4004) while CI omits CHATAPP_INSTANCES; otherwise deploy-prod-multi
# would re-enable :4004 when this script defaulted to 5. Fall back to caller env, then 5.
_chatapp_remote=""
_chatapp_remote=$(ssh_prod "grep -E '^CHATAPP_INSTANCES=' /opt/chatapp/shared/.env 2>/dev/null | tail -1 | cut -d= -f2-" 2>/dev/null || true)
_chatapp_remote=$(printf '%s' "${_chatapp_remote}" | tr -d '[:space:]' | tr -d '\r')
if [[ "${_chatapp_remote}" =~ ^[0-9]+$ ]] && [ "${_chatapp_remote}" -ge 1 ] && [ "${_chatapp_remote}" -le 8 ]; then
  CHATAPP_INSTANCES="${_chatapp_remote}"
else
  CHATAPP_INSTANCES=${CHATAPP_INSTANCES:-5}
fi
unset _chatapp_remote

# shellcheck source=deploy-prod-remote-sizing.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-remote-sizing.sh"

echo "=== PRODUCTION DEPLOYMENT ==="
echo "Release: $RELEASE_SHA"
echo "Target: $PROD_USER@$PROD_HOST"
echo "  VM vCPUs: ${_REMOTE_NCPU}  workers: ${CHATAPP_INSTANCES}  pgbouncer_pool: ${_PGB_SIZE}  pg_max_conn: ${PG_MAX_CONNECTIONS}"
echo "  PG_POOL_MAX/instance: ${PG_POOL_MAX_PER_INSTANCE}  pool_circuit_queue: ${POOL_CIRCUIT_BREAKER_QUEUE}"
echo "  UV threadpool/instance: ${UV_THREADPOOL_PER_INSTANCE}  bcrypt_conc: ${BCRYPT_MAX_CONCURRENT}"
echo "  communities_heavy_max_inflight: ${COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT}"
notify_discord_prod ":rocket: **Prod deploy starting** \`${RELEASE_SHA:0:7}\` · ${CHATAPP_INSTANCES} workers · SKIP_BACKUP=${SKIP_BACKUP:-false}"

if ! [[ "${CHATAPP_INSTANCES}" =~ ^[0-9]+$ ]] || [ "${CHATAPP_INSTANCES}" -lt 1 ]; then
  echo "ERROR: CHATAPP_INSTANCES must be a positive integer (got '${CHATAPP_INSTANCES}')."
  exit 1
fi
if [ "${CHATAPP_INSTANCES}" -gt 8 ]; then
  echo "ERROR: CHATAPP_INSTANCES=${CHATAPP_INSTANCES} is unexpectedly high; refusing deploy."
  exit 1
fi

BASE_APP_PORT=4000
TARGET_PORTS=()
for ((idx=0; idx<CHATAPP_INSTANCES; idx++)); do
  TARGET_PORTS+=( "$((BASE_APP_PORT + idx))" )
done

WORKER_ONLY_HOST=0
if [ "${SKIP_INGRESS_POST_DEPLOY:-0}" = "1" ]; then
  WORKER_ONLY_HOST=1
fi

# First server port inside `upstream app` only (avoids accidental matches elsewhere and
# duplicate-line collapse where a naive grep | head picked an arbitrary port).
CURRENT_UPSTREAM_PORT=""
if [ "${WORKER_ONLY_HOST}" -ne 1 ]; then
CURRENT_UPSTREAM_PORT=$(ssh_prod "SITE='${CHATAPP_NGINX_SITE_PATH}' python3 <<'PY'
import os
import re
from pathlib import Path
p = Path(os.environ['SITE'])
if not p.is_file():
    print('')
    raise SystemExit(0)
t = p.read_text()
m = re.search(r'upstream app \\{([^}]+)\\}', t, re.DOTALL)
if not m:
    print('')
    raise SystemExit(0)
ports = re.findall(r'server\\s+(?:127\\.0\\.0\\.1|localhost):(\\d+)', m.group(1))
print(ports[0] if ports else '')
PY" || true)
fi
if [[ -z "${CURRENT_UPSTREAM_PORT}" ]]; then
  CURRENT_UPSTREAM_PORT="${TARGET_PORTS[0]}"
fi

if [ "${CHATAPP_INSTANCES}" -ge 3 ]; then
  if [ "${WORKER_ONLY_HOST}" -ne 1 ] && ! printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${CURRENT_UPSTREAM_PORT}"; then
    echo "ERROR: Unexpected upstream port '${CURRENT_UPSTREAM_PORT}' in nginx config."
    exit 1
  fi
  OLD_PORT="${CURRENT_UPSTREAM_PORT}"
  # Rolling restart: first-to-roll = last TARGET_PORT (e.g. 4003 for 4 workers).
  # No spare port outside TARGET_PORTS — workers never exceed CHATAPP_INSTANCES simultaneously,
  # so PgBouncer pool stays bounded at inst×PG_POOL_MAX with zero overrun risk on cutover.
  # Last worker port (bash 3.2 on macOS has no array[-1]; use explicit index).
  NEW_PORT="${TARGET_PORTS[$((CHATAPP_INSTANCES - 1))]}"
  ROLLING_RESTART=true
else
  ROLLING_RESTART=false
  if [ "${WORKER_ONLY_HOST}" -eq 1 ]; then
    OLD_PORT=4000
    NEW_PORT=4001
  elif [[ "${CURRENT_UPSTREAM_PORT}" == "4000" ]]; then
    OLD_PORT=4000
    NEW_PORT=4001
  elif [[ "${CURRENT_UPSTREAM_PORT}" == "4001" ]]; then
    OLD_PORT=4001
    NEW_PORT=4000
  else
    echo "ERROR: Unexpected upstream port '${CURRENT_UPSTREAM_PORT}' in nginx config."
    exit 1
  fi
fi

echo "Current live port: $OLD_PORT"
echo "Candidate port: $NEW_PORT"

ADDITIONAL_PORTS=()
for p in "${TARGET_PORTS[@]}"; do
  if [ "$p" != "$OLD_PORT" ] && [ "$p" != "$NEW_PORT" ]; then
    ADDITIONAL_PORTS+=( "$p" )
  fi
done

TARGET_PORTS_CSV=$(IFS=,; echo "${TARGET_PORTS[*]}")
echo "Target app worker ports: ${TARGET_PORTS[*]}"
# shellcheck disable=SC2034 # mutated by capture_previous_release_map; read in deploy-prod-rolling.sh / rollback
PREV_RELEASE_MAP=()
# shellcheck disable=SC2034
PREV_ACTIVE_PORTS=()
# shellcheck disable=SC2034
PREV_ACTIVE_PORTS_CSV=""
NGINX_CANDIDATE_PIN_ACTIVE=0
ROLLBACK_ALREADY_ATTEMPTED=0

# shellcheck source=deploy-prod-rolling.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-rolling.sh"
# shellcheck source=deploy-prod-phases.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-phases.sh"

ssh_prod "sudo logger -t chatapp-deploy \"event=start sha=${RELEASE_SHA} old_port=${OLD_PORT} new_port=${NEW_PORT} instances=${CHATAPP_INSTANCES}\"" || true

echo ""
if [[ "${FAST_ROLLBACK}" == "true" ]]; then
  echo "⚠️  ROLLBACK: This will revert all ${CHATAPP_INSTANCES} workers to release ${RELEASE_SHA} on PRODUCTION."
  echo "    Release must already exist in ${RELEASE_DIR}/ on ${PROD_HOST}."
else
  echo "⚠️  This will deploy to PRODUCTION. Verify staging is working first."
fi
echo ""

# Skip confirmation in GitHub Actions, or when Ansible/CI sets DEPLOY_NON_INTERACTIVE=true
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${DEPLOY_NON_INTERACTIVE:-}" = "true" ]; then
  echo "(Non-interactive deploy: proceeding without confirmation)"
else
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

acquire_remote_deploy_lock
trap cleanup_on_exit EXIT

# Fast rollback: skip backup, artifact download/unpack, migrations, pgbouncer, monitoring
if [[ "${FAST_ROLLBACK}" == "true" ]]; then
  do_fast_rollback
  exit 0
fi

# 1. Verify artifact exists
if [[ -n "$LOCAL_ARTIFACT_PATH" ]]; then
  echo "1. Using local CI artifact..."
  if [[ ! -f "$LOCAL_ARTIFACT_PATH" ]]; then
    echo "ERROR: Local artifact not found at $LOCAL_ARTIFACT_PATH"
    exit 1
  fi
  echo "✓ Local artifact found"
else
  echo "1. Verifying artifact exists..."
  if ! gh release view "release-${RELEASE_SHA}" -R "$GITHUB_REPO" >/dev/null 2>&1; then
    echo "ERROR: Release not found. Check SHA and GitHub access."
    exit 1
  fi
  echo "✓ Release found"
fi

# 2. Backup database before risky deploy (strict — deploy aborts if backup fails).
# Never pg_dump through PgBouncer transaction pool (unreliable COPY); use PGDUMP_DATABASE_URL.
# Set SKIP_BACKUP=true for config-only deploys (same SHA, env-var change only) to avoid
# running gzip compression on the app VM while the grader is live.
# Auto-skip if no pending migrations (saves 5-10 min on a 7+ GB DB).
if [[ "${SKIP_BACKUP:-false}" != "true" ]]; then
  echo "2. Checking for pending migrations..."
  PENDING_MIGRATIONS=$(ssh_prod bash -s -- "$RELEASE_SHA" <<'CHECK_MIGRATIONS'
set -euo pipefail
RELEASE_SHA_REMOTE="$1"
source /opt/chatapp/shared/.env
RELEASE_MIGRATIONS="/opt/chatapp/releases/${RELEASE_SHA_REMOTE}/migrations"
# Fall back to current symlink if release dir not yet extracted
[[ -d "$RELEASE_MIGRATIONS" ]] || RELEASE_MIGRATIONS="/opt/chatapp/current/migrations"
MIGRATE_DB="${PGDUMP_DATABASE_URL:-$DATABASE_URL}"
APPLIED=$(psql "$MIGRATE_DB" -qAt -c "SELECT filename FROM schema_migrations;" 2>/dev/null || echo "")
PENDING=0
for f in "$RELEASE_MIGRATIONS"/*.sql; do
  fname=$(basename "$f")
  if ! echo "$APPLIED" | grep -qx "$fname"; then
    PENDING=$((PENDING + 1))
  fi
done
echo "$PENDING"
CHECK_MIGRATIONS
  )
  if [[ "${PENDING_MIGRATIONS:-0}" -eq 0 ]]; then
    echo "2. No pending migrations — skipping database backup (saves ~5-10 min)"
    deploy_log_phase "database backup skipped (no pending migrations)"
    SKIP_BACKUP=true
  else
    echo "2. Found ${PENDING_MIGRATIONS} pending migration(s) — backup required"
  fi
fi

if [[ "${SKIP_BACKUP:-false}" == "true" ]]; then
  : # already logged above
else
echo "2. Backing up database..."
ssh_prod bash -s <<'REMOTE_BACKUP'
set -euo pipefail
set -o pipefail
BACKUP_DIR=/opt/chatapp/backups
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/postgres-backup-${STAMP}.sql.gz"
set -a
source /opt/chatapp/shared/.env
set +a
case "${DATABASE_URL:-}" in
  *:6432*)
    if [[ -z "${PGDUMP_DATABASE_URL:-}" ]]; then
      echo "ERROR: DATABASE_URL points at PgBouncer (:6432). Set PGDUMP_DATABASE_URL in /opt/chatapp/shared/.env (direct postgres://user:pass@DB_HOST:5432/DBNAME)."
      exit 1
    fi
    DUMP_URL="$PGDUMP_DATABASE_URL"
    ;;
  *)
    DUMP_URL="${PGDUMP_DATABASE_URL:-$DATABASE_URL}"
    ;;
esac
ok=0
for attempt in 1 2 3; do
  # Run pg_dump and gzip at low priority (nice 15) so app workers always get CPU first.
  if nice -n 15 pg_dump "$DUMP_URL" | nice -n 15 gzip -c >"${BACKUP_FILE}.part"; then
    mv -f "${BACKUP_FILE}.part" "$BACKUP_FILE"
    ok=1
    break
  fi
  echo "pg_dump attempt ${attempt} failed; retrying in 15s..."
  rm -f "${BACKUP_FILE}.part"
  sleep 15
done
if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: pg_dump failed after 3 attempts"
  exit 1
fi
gzip -t "$BACKUP_FILE"
ls -lh "$BACKUP_FILE"
echo "Backup OK: $BACKUP_FILE"
REMOTE_BACKUP
echo "✓ Backup prepared"
deploy_log_phase "database backup complete"
fi  # end SKIP_BACKUP check

# 2b. Install/configure PgBouncer (idempotent — safe on every deploy)
echo "2b) Installing and configuring PgBouncer..."
ssh_prod "mkdir -p \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}\""
chatapp_scp_to_prod "${SCRIPT_DIR}/pgbouncer-setup.py" "${PROD_USER}@${PROD_HOST}:${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer-setup.py"
chatapp_scp_to_prod "${SCRIPT_DIR}/pgbouncer_ini_backend_is_remote.py" "${PROD_USER}@${PROD_HOST}:${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer_ini_backend_is_remote.py"
ssh_prod "
  set -euo pipefail
  if ! dpkg -l pgbouncer 2>/dev/null | grep -q '^ii'; then
    sudo apt-get install -y pgbouncer
    echo 'PgBouncer installed.'
  fi
  sudo mkdir -p /var/run/pgbouncer
  sudo chown postgres:postgres /var/run/pgbouncer
  sudo tee /etc/tmpfiles.d/pgbouncer-chatapp.conf >/dev/null <<'TMPFILES'
d /var/run/pgbouncer 0755 postgres postgres -
TMPFILES
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/pgbouncer-chatapp.conf 2>/dev/null || true
  # Hash the existing config so we can detect changes and avoid a gratuitous SIGHUP.
  # PgBouncer SIGHUP is non-disruptive but we skip it when pool math is unchanged
  # (typical code-only redeploy) to eliminate any transient connection stall risk.
  _pgb_hash_before=\$(sha256sum /etc/pgbouncer/pgbouncer.ini 2>/dev/null | awk '{print \$1}' || echo none)
  sudo env PGBOUNCER_POOL_SIZE=${_PGB_SIZE} PGBOUNCER_MAX_DB_CONNECTIONS=${PGBOUNCER_MAX_DB_CONNECTIONS} PGBOUNCER_MIN_POOL_SIZE=${PGBOUNCER_MIN_POOL_SIZE} PGBOUNCER_RESERVE_SIZE=${PGBOUNCER_RESERVE_SIZE} PG_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS} PG_PRIMARY_HOST=\"${PG_PRIMARY_HOST:-${CHATAPP_INV_DB_INTERNAL:-10.0.1.62}}\" CHATAPP_INV_DB_INTERNAL=\"${CHATAPP_INV_DB_INTERNAL:-10.0.1.62}\" python3 \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer-setup.py\"
  _pgb_hash_after=\$(sha256sum /etc/pgbouncer/pgbouncer.ini 2>/dev/null | awk '{print \$1}' || echo none)
  sudo systemctl enable pgbouncer
  if [ \"${ALLOW_DB_RESTART}\" = \"true\" ]; then
    sudo service pgbouncer stop 2>/dev/null || true
    sudo pkill -x pgbouncer 2>/dev/null || true
    sleep 1
    sudo service pgbouncer start
    sleep 1
  else
    if sudo systemctl is-active pgbouncer >/dev/null 2>&1; then
      # PgBouncer is running; only reload (SIGHUP) if config actually changed.
      # Reload is non-disruptive: existing connections are preserved, new config
      # applies to new connections. Skip when unchanged (typical code-only deploy).
      if [ \"\$_pgb_hash_before\" != \"\$_pgb_hash_after\" ]; then
        echo \"PgBouncer config changed — reloading (pool size or conn params updated)\"
        sudo systemctl reload pgbouncer
        sleep 1   # brief settle so PgBouncer applies new config before TCP check
      else
        echo \"PgBouncer config unchanged — skipping reload\"
      fi
    else
      # Not running: start it
      sudo service pgbouncer start
    fi
  fi
  sudo systemctl is-active pgbouncer \
    || { echo 'ERROR: pgbouncer failed to start'; sudo journalctl -u pgbouncer --no-pager -n 20; exit 1; }
  # systemctl active can race before the pooler accepts TCP — same check as chatapp ExecStartPre.
  wait_tcp() {
    local host=\"\$1\" port=\"\$2\" label=\"\$3\" max=\"\${4:-90}\"
    local n=0
    while [ \"\$n\" -lt \"\$max\" ]; do
      if { echo > /dev/tcp/\${host}/\${port}; } >/dev/null 2>&1; then
        echo \"\${label} accepting connections on \${host}:\${port}\"
        return 0
      fi
      sleep 1
      n=\$((n+1))
    done
    echo \"ERROR: \${label} not reachable at \${host}:\${port} after \${max}s\"
    return 1
  }
  wait_tcp 127.0.0.1 6432 PgBouncer 90
  echo 'PgBouncer running on 127.0.0.1:6432 in transaction-pooling mode.'
"
echo "✓ PgBouncer configured"

# 2c. PostgreSQL tuning on the app VM — only when PgBouncer talks to co-located Postgres.
# If the pooler backend is a remote host, skip (ALTER SYSTEM here would touch the wrong cluster).
echo "2c) Tuning PostgreSQL for prod VM..."
ssh_prod "
  set -euo pipefail
  # Primary signal: helper inspects PgBouncer backend in pgbouncer.ini.
  if python3 \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer_ini_backend_is_remote.py\" 2>/dev/null; then
    echo 'Skipping local PostgreSQL tuning — PgBouncer backend is off-host.'
    echo 'On the database VM run: DB_SSH=user@db-host ./deploy/tune-remote-db-postgres.sh'
    exit 0
  fi
  # Fallback signal: parse PGDUMP_DATABASE_URL / DATABASE_URL from shared .env.
  # This prevents false local-tune attempts when helper is missing or cannot parse.
  if python3 - <<'PY'
import os
from pathlib import Path
from urllib.parse import urlparse

env_path = Path('/opt/chatapp/shared/.env')
if not env_path.is_file():
    raise SystemExit(1)

env = {}
for raw in env_path.read_text(encoding='utf-8', errors='replace').splitlines():
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    if line.startswith('export '):
        line = line[7:].strip()
    k, _, v = line.partition('=')
    k = k.strip()
    v = v.strip().strip('\"').strip(\"'\")
    env[k] = v

url = (env.get('PGDUMP_DATABASE_URL') or env.get('DATABASE_URL') or '').strip()
if not url:
    raise SystemExit(1)
if url.startswith('postgres://'):
    url = 'postgresql://' + url[len('postgres://'):]
elif url.startswith('postgresql+asyncpg://'):
    url = 'postgresql://' + url[len('postgresql+asyncpg://'):]
if not url.startswith('postgresql://'):
    raise SystemExit(1)
host = urlparse(url).hostname
if host and host not in ('localhost', '127.0.0.1', '::1'):
    raise SystemExit(0)
raise SystemExit(1)
PY
  then
    echo 'Skipping local PostgreSQL tuning — PgBouncer backend is off-host.'
    echo 'On the database VM run: DB_SSH=user@db-host ./deploy/tune-remote-db-postgres.sh'
    exit 0
  fi
  TOTAL_RAM_MB=\$(awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo)
  NCPU=\$(nproc --all)
  SHB_MB=\$(( TOTAL_RAM_MB * 19 / 100 ))
  ECF_MB=\$(( TOTAL_RAM_MB * 75 / 100 ))
  PG_MAX_CONNECTIONS='${PG_MAX_CONNECTIONS}'
  WRK_MB=\$(python3 -c \"ram=\${TOTAL_RAM_MB}; mc=int('\${PG_MAX_CONNECTIONS}'); print(max(4, min(32, ram // max(mc * 4, 1))))\")
  echo \"RAM=\${TOTAL_RAM_MB}MB max_conn=\${PG_MAX_CONNECTIONS} → shared_buffers=\${SHB_MB}MB work_mem=\${WRK_MB}MB\"
  sudo -u postgres psql -qAt \
    -c \"ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';\" \
    2>&1 | grep -v 'change directory' || true
  sudo -u postgres psql -qAt \
    -c \"ALTER SYSTEM SET shared_buffers         = '\${SHB_MB}MB';\" \
    -c \"ALTER SYSTEM SET effective_cache_size   = '\${ECF_MB}MB';\" \
    -c \"ALTER SYSTEM SET work_mem               = '\${WRK_MB}MB';\" \
    -c \"ALTER SYSTEM SET wal_buffers            = '32MB';\" \
    -c \"ALTER SYSTEM SET checkpoint_completion_target = '0.9';\" \
    -c \"ALTER SYSTEM SET random_page_cost       = '1.1';\" \
    -c \"ALTER SYSTEM SET max_connections        = \${PG_MAX_CONNECTIONS};\" \\
    2>&1 | grep -v 'change directory' || true
  sudo -u postgres psql -qAt -c \"SELECT pg_reload_conf();\" > /dev/null || true
  PENDING=\$(sudo -u postgres psql -qAt -c \"SELECT EXISTS (SELECT 1 FROM pg_settings WHERE pending_restart)\")
  if [ \"\$PENDING\" = \"t\" ]; then
    if [ \"${ALLOW_DB_RESTART}\" = \"true\" ]; then
      echo 'PostgreSQL: pending_restart and ALLOW_DB_RESTART=true — restarting postmaster once.'
      sudo systemctl restart postgresql
      sleep 3
    else
      echo 'PostgreSQL: pending_restart detected but restart skipped (ALLOW_DB_RESTART=false).'
    fi
  else
    echo 'PostgreSQL: no pending_restart — reload only.'
  fi
  sudo systemctl is-active postgresql \
    || { echo 'ERROR: PostgreSQL is not active after tuning'; exit 1; }
  sudo -u postgres psql chatapp_prod -qAt \
    -c \"CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\" \
    2>&1 | grep -v 'change directory' || true
  sudo -u postgres psql -qAt \
    -c \"ALTER SYSTEM SET pg_stat_statements.track = 'all';\" \
    2>&1 | grep -v 'change directory' || true
  sudo -u postgres psql -qAt -c \"SELECT pg_reload_conf();\" > /dev/null || true
  echo 'PostgreSQL tuning applied.'
  # After a postmaster bounce, PgBouncer may need a moment before 6432 serves queries again.
  if [ \"${ALLOW_DB_RESTART}\" = \"true\" ]; then
    wait_tcp() {
      local host=\"\$1\" port=\"\$2\" label=\"\$3\" max=\"\${4:-120}\"
      local n=0
      while [ \"\$n\" -lt \"\$max\" ]; do
        if { echo > /dev/tcp/\${host}/\${port}; } >/dev/null 2>&1; then
          echo \"\${label} accepting connections on \${host}:\${port} (post-PostgreSQL)\"
          return 0
        fi
        sleep 1
        n=\$((n+1))
      done
      echo \"ERROR: \${label} not reachable at \${host}:\${port} after \${max}s\"
      return 1
    }
    wait_tcp 127.0.0.1 6432 PgBouncer 120
  fi
"
echo "✓ PostgreSQL tuned"

# Include $$ so parallel deploy-prod.sh invocations (e.g. parallel VM2+VM3
# rollout from deploy-prod-multi.sh) don't race on the same local /tmp path.
DOWNLOAD_PATH="/tmp/chatapp-${RELEASE_SHA}-$$.tar.gz"
# cleanup_on_exit (registered above) already runs _cleanup_download_path + deploy lock + ssh tmpdir cleanup.
# Do not replace that EXIT trap — a prior bug used trap _combined_cleanup here and skipped rollback/lock release.
# 3. Download artifact to prod
if [[ -n "$LOCAL_ARTIFACT_PATH" ]]; then
  echo "3. Using local artifact..."
  cp "$LOCAL_ARTIFACT_PATH" "$DOWNLOAD_PATH"
else
  echo "3. Downloading artifact from GitHub Releases..."
  _gh_download_ok=0
  for _attempt in 1 2 3 4 5; do
    if gh release download "release-${RELEASE_SHA}" -R "$GITHUB_REPO" \
      -p "chatapp-${RELEASE_SHA}.tar.gz" -O "$DOWNLOAD_PATH"; then
      _gh_download_ok=1
      break
    fi
    if [[ "${_attempt}" -lt 5 ]]; then
      echo "WARN: gh release download failed (attempt ${_attempt}/5); sleeping 30s..."
      sleep 30
    fi
  done
  if [[ "${_gh_download_ok}" -ne 1 ]]; then
    echo "ERROR: Failed to download artifact after 5 attempts."
    echo "      Build locally: ./scripts/release/package-release-artifact.sh"
    echo "      Then: LOCAL_ARTIFACT_PATH=\$PWD/releases/chatapp-${RELEASE_SHA}.tar.gz ./deploy/deploy-prod.sh ${RELEASE_SHA}"
    exit 1
  fi
fi

# 3a. Fail closed before scp: tarball must embed backend/dist/.build-sha matching RELEASE_SHA
# (prevents stale LOCAL_ARTIFACT_PATH or mis-tagged tarballs from shipping wrong compiled output).
CHATAPP_REPO_ROOT="${CHATAPP_REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
echo "3a) Verifying tarball backend/dist/.build-sha matches deploy SHA ${RELEASE_SHA}..."
if ! chatapp_verify_release_tarball_build_sha "$DOWNLOAD_PATH" "$RELEASE_SHA" "$CHATAPP_REPO_ROOT"; then
  rm -f "$DOWNLOAD_PATH" 2>/dev/null || true
  exit 1
fi

echo "✓ Artifact ready locally"

# 3b. SHA-256 of bytes we are about to ship (detect local corruption / truncates before scp).
ARTIFACT_SHA256=$(openssl dgst -sha256 "$DOWNLOAD_PATH" | awk '{print $2}')
echo "Artifact SHA256 (local): ${ARTIFACT_SHA256}"

# 4. Copy to production server
# Use the canonical remote filename (without the local $$ suffix) so the
# unpack step on the host can find it regardless of which deploy-prod.sh
# process produced it.
echo "4. Copying to production..."
chatapp_scp_to_prod "$DOWNLOAD_PATH" "$PROD_USER@$PROD_HOST:/tmp/chatapp-${RELEASE_SHA}.tar.gz"
chatapp_scp_to_prod "${SCRIPT_DIR}/health-check.sh" "${SCRIPT_DIR}/smoke-test.sh" "${SCRIPT_DIR}/candidate-ws-smoke.cjs" "$PROD_USER@$PROD_HOST:/tmp/"
rm "$DOWNLOAD_PATH"
echo "✓ Copied to production"

# 5. Unpack candidate release
echo "5. Unpacking candidate release..."
ssh_prod "
  set -eo pipefail
  REMOTE_TGZ=/tmp/chatapp-${RELEASE_SHA}.tar.gz
  GOT=\$(openssl dgst -sha256 \"\$REMOTE_TGZ\" | awk '{print \$2}')
  if [ \"\$GOT\" != \"${ARTIFACT_SHA256}\" ]; then
    echo \"ERROR: artifact SHA256 mismatch after copy (truncated or corrupted transfer)\"
    echo \"  expected: ${ARTIFACT_SHA256}\"
    echo \"  actual:   \$GOT\"
    exit 1
  fi
  echo \"✓ Artifact SHA256 verified on host\"
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
  
  mkdir -p $RELEASE_DIR
  mkdir -p \$RELEASE_PATH
  tar xzf \"\$REMOTE_TGZ\" -C \$RELEASE_PATH
  
  # Backend dependencies are pre-bundled by scripts/release/package-release-artifact.sh.
  # Do not run npm ci on the VM: the release tarball must include node_modules.
  # npm workspaces hoists shared deps to the repo-root node_modules/, so express may
  # live at \$RELEASE_PATH/node_modules/express rather than \$RELEASE_PATH/backend/node_modules/express.
  cd \$RELEASE_PATH/backend
  if [ ! -d node_modules/express ] && [ ! -d ../node_modules/express ]; then
    echo 'ERROR: express not found in release artifact (neither backend/node_modules/express nor node_modules/express).'
    echo '       Rebuild with scripts/release/package-release-artifact.sh so node_modules is bundled.'
    exit 1
  fi

  if [ \"${RUN_DB_MIGRATIONS:-1}\" = \"1\" ]; then
    # Run DB migrations before any new API instance starts.
    set -a
    source /opt/chatapp/shared/.env
    set +a
    MIGRATE_DATABASE_URL=\${PGDUMP_DATABASE_URL:-\$DATABASE_URL}
    export DATABASE_URL=\"\$MIGRATE_DATABASE_URL\"
    node \$RELEASE_PATH/backend/dist/db/migrate.js

    # Fail fast if migrations did not create core tables (wrong DB, broken artifact, etc.).
    cd \$RELEASE_PATH/backend
    DATABASE_URL=\"\$MIGRATE_DATABASE_URL\" node -e \"
const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Post-migrate check: DATABASE_URL missing'); process.exit(1); }
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query(
    \\\"SELECT to_regclass('public.messages') AS m, to_regclass('public.read_states') AS r, \\\" +
    \\\"to_regclass('public.channels') AS ch, to_regclass('public.schema_migrations') AS sm\\\"
  );
  await c.end();
  const miss = [];
  if (!rows[0].m) miss.push('messages');
  if (!rows[0].r) miss.push('read_states');
  if (!rows[0].ch) miss.push('channels');
  if (!rows[0].sm) miss.push('schema_migrations');
  if (miss.length) {
    console.error('Post-migrate schema check failed — missing: ' + miss.join(', '));
    process.exit(1);
  }
  console.log('Post-migrate schema OK');
})().catch((e) => { console.error(e); process.exit(1); });
\"
  else
    echo 'Skipping DB migrations on this host (RUN_DB_MIGRATIONS=0)'
  fi
  
  # Frontend is pre-built, but verify
  if [ ! -d \$RELEASE_PATH/frontend/dist ]; then
    echo 'ERROR: Frontend dist not found in artifact'
    exit 1
  fi

  chmod +x /tmp/health-check.sh /tmp/smoke-test.sh
  
  echo 'Release unpacked and verified'
"
echo "✓ Candidate release ready"
deploy_log_phase "candidate release unpacked on VM"
capture_previous_release_map

# 5.5. Install/update systemd unit
echo "5.5. Installing/updating systemd unit..."
_PROD_DEPLOY_OVERLAY_ENV=$(mktemp)
{
  echo "CHATAPP_INSTANCES=${CHATAPP_INSTANCES}"
  echo "BCRYPT_ROUNDS=1"
  echo "UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}"
  echo "PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}"
  echo "PGBOUNCER_POOL_SIZE=${_PGB_SIZE}"
  echo "PGBOUNCER_MAX_DB_CONNECTIONS=${PGBOUNCER_MAX_DB_CONNECTIONS}"
  echo "PGBOUNCER_MIN_POOL_SIZE=${PGBOUNCER_MIN_POOL_SIZE}"
  echo "PGBOUNCER_RESERVE_SIZE=${PGBOUNCER_RESERVE_SIZE}"
  echo "POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}"
  echo "BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}"
  echo "PG_CONNECTION_TIMEOUT_MS=7000"
  echo "BG_WRITE_POOL_GUARD=5"
  echo "SEARCH_STATEMENT_TIMEOUT_MS=10000"
  echo "JWT_ACCESS_TTL=24h"
  echo "JWT_REFRESH_TTL=7d"
  echo "NODE_ENV=production"
  echo "AUTH_BYPASS=false"
  echo "LOG_LEVEL=info"
  echo "FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}"
  echo "NODE_OPTIONS=\"--max-old-space-size=${NODE_OLD_SPACE_MB} --max-semi-space-size=16\""
  echo "AUTH_GLOBAL_PER_IP_RATE_LIMIT=false"
  echo "AUTH_PASSWORD_STORAGE_MODE=plain"
  echo "CHATAPP_ROLE=${CHATAPP_ROLE:-app}"
} > "${_PROD_DEPLOY_OVERLAY_ENV}"
# Use an ssh stdin pipe instead of scp: OpenSSH >=9.0 switches scp to the SFTP
# subsystem which misparses '@' in remote paths, causing "Permission denied".
# Batch helper/config files into one tar stream to avoid five separate SSH/SCP round trips.
_PROD_DEPLOY_BUNDLE_DIR=$(mktemp -d)
cp "${SCRIPT_DIR}/chatapp-template.service" "${_PROD_DEPLOY_BUNDLE_DIR}/chatapp-template.service"
cp "${SCRIPT_DIR}/redis-wait.sh" "${_PROD_DEPLOY_BUNDLE_DIR}/redis-wait.sh"
cp "${SCRIPT_DIR}/apply-env-profile.py" "${_PROD_DEPLOY_BUNDLE_DIR}/apply-env-profile.py"
cp "${SCRIPT_DIR}/env/prod.required.env" "${_PROD_DEPLOY_BUNDLE_DIR}/prod.required.env"
cp "${_PROD_DEPLOY_OVERLAY_ENV}" "${_PROD_DEPLOY_BUNDLE_DIR}/prod.deploy.overlay.env"
if ! tar -C "${_PROD_DEPLOY_BUNDLE_DIR}" -cf - \
  chatapp-template.service \
  redis-wait.sh \
  apply-env-profile.py \
  prod.required.env \
  prod.deploy.overlay.env \
  | ssh_prod 'tar xf - -C /tmp'; then
  rm -f "${_PROD_DEPLOY_OVERLAY_ENV}"
  rm -rf "${_PROD_DEPLOY_BUNDLE_DIR}"
  exit 1
fi
rm -f "${_PROD_DEPLOY_OVERLAY_ENV}"
rm -rf "${_PROD_DEPLOY_BUNDLE_DIR}"
ssh_prod "
  set -eo pipefail
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
  sed 's/__DEPLOY_USER__/${PROD_USER}/g' /tmp/chatapp-template.service | sudo tee /etc/systemd/system/chatapp@.service > /dev/null
  sudo cp /tmp/redis-wait.sh /opt/chatapp/shared/redis-wait.sh
  sudo chmod +x /opt/chatapp/shared/redis-wait.sh
  # PORT must not be in shared .env — systemd provides it via Environment=PORT=%i
  sudo sed -i '/^PORT=/d' /opt/chatapp/shared/.env
  # Merge git-tracked prod.required.env with deploy-computed overlay (overlay wins on duplicate keys).
  MERGED=/tmp/prod.merged.required.env
  BASE=/tmp/prod.required.env
  if [ -f \"\${RELEASE_PATH}/deploy/env/prod.required.env\" ]; then
    BASE=\"\${RELEASE_PATH}/deploy/env/prod.required.env\"
  fi
  cat \"\$BASE\" > \"\$MERGED\"
  cat /tmp/prod.deploy.overlay.env >> \"\$MERGED\"
  sudo python3 /tmp/apply-env-profile.py \
    --target /opt/chatapp/shared/.env \
    --required \"\$MERGED\"
  rm -f \"\$MERGED\" /tmp/prod.deploy.overlay.env
  echo 'profile-owned keys (post-merge):'
  sudo grep -E '^(CHANNEL_MESSAGE_USER_FANOUT|CHANNEL_MESSAGE_USER_FANOUT_MODE|MESSAGE_USER_FANOUT_HTTP_BLOCKING|WS_AUTO_SUBSCRIBE_MODE|WS_BOOTSTRAP_BATCH_SIZE|WS_BOOTSTRAP_CACHE_TTL_SECONDS|READ_RECEIPT_DEFER_POOL_WAITING|OVERLOAD_HTTP_SHED_ENABLED|OVERLOAD_LAG_SHED_MS)=' /opt/chatapp/shared/.env
  rm -f /tmp/apply-env-profile.py /tmp/prod.required.env
  sudo systemctl daemon-reload
  echo 'systemd unit installed'"
echo "✓ systemd unit ready"

# 6-pre. Rolling restart: remove first-to-roll worker from nginx before updating it.
# This ensures the worker is never restarted while nginx still routes live traffic to it.
if [ "${ROLLING_RESTART:-false}" = "true" ]; then
  echo "6-pre. Removing :${NEW_PORT} from nginx upstream (N-1 workers absorb traffic while candidate is updated)..."
  _ROLL_PRE_REMAINING_CSV=""
  for _p in "${TARGET_PORTS[@]}"; do
    [ "$_p" != "${NEW_PORT}" ] && _ROLL_PRE_REMAINING_CSV="${_ROLL_PRE_REMAINING_CSV:+${_ROLL_PRE_REMAINING_CSV},}${_p}"
  done
  rewrite_nginx_upstream "${_ROLL_PRE_REMAINING_CSV}" "pre-roll remove :${NEW_PORT}" || {
    echo "ERROR: failed to remove :${NEW_PORT} from nginx for rolling restart"
    exit 1
  }
  nginx_drain_after_upstream_removal "before restarting first worker :${NEW_PORT}"
  NGINX_CANDIDATE_PIN_ACTIVE=1
  echo "✓ :${NEW_PORT} removed from nginx (${_ROLL_PRE_REMAINING_CSV} still serving)"
fi

# 6. Start candidate on alternate port via systemd
echo "6. Starting candidate process via systemd..."
ssh_prod "
  set -euo pipefail
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA

  # Write per-port drop-in so systemd uses this release's working directory.
  DROPIN_DIR=/etc/systemd/system/chatapp@${NEW_PORT}.service.d
  sudo mkdir -p \$DROPIN_DIR
  printf '[Service]\nWorkingDirectory=%s/backend\n' \$RELEASE_PATH | sudo tee \${DROPIN_DIR}/release.conf > /dev/null
  sudo systemctl daemon-reload

  # Stop any stale process on candidate port, then start fresh.
  sudo systemctl stop chatapp@${NEW_PORT} 2>/dev/null || true
  sleep 1
  sudo systemctl start chatapp@${NEW_PORT}

  echo 'Candidate started via systemd (chatapp@${NEW_PORT})'
"
echo "✓ Candidate process started on port $NEW_PORT"

# 7. Health checks
echo "7. Running health checks on candidate..."
ssh_prod "/tmp/health-check.sh ${NEW_PORT} http://127.0.0.1:${NEW_PORT}" || {
  echo "ERROR: Health check failed. Stopping candidate."
  stop_chatapp_port "$NEW_PORT"
  exit 1
}
echo "✓ Health checks passed"

# 8. Smoke tests
echo "8. Running smoke tests..."
ssh_prod "/tmp/smoke-test.sh ${NEW_PORT} http://127.0.0.1:${NEW_PORT}" || {
  echo "ERROR: Smoke tests failed. Stopping candidate."
  stop_chatapp_port "$NEW_PORT"
  exit 1
}
echo "✓ Smoke tests passed"

if [ "${WORKER_ONLY_HOST}" -eq 1 ]; then
  echo "8b. Candidate WebSocket message round-trip skipped (worker-only host)"
else
  echo "8b. Candidate WebSocket message round-trip..."
  ssh_prod "
    set -euo pipefail
    RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
    export API_CONTRACT_BASE_URL=http://127.0.0.1:$NEW_PORT/api/v1
    export API_CONTRACT_WS_URL=ws://127.0.0.1:$NEW_PORT/ws
    cp /tmp/candidate-ws-smoke.cjs \"\$RELEASE_PATH/backend/candidate-ws-smoke.cjs\"
    cd \"\$RELEASE_PATH/backend\" && node ./candidate-ws-smoke.cjs
    rm -f \"\$RELEASE_PATH/backend/candidate-ws-smoke.cjs\"
  " || {
    echo "ERROR: Candidate WS smoke failed. Stopping candidate."
    stop_chatapp_port "$NEW_PORT"
    exit 1
  }
  echo "✓ Candidate WS smoke passed"
  deploy_log_phase "candidate WS smoke OK"
fi

# 8b.5. Rolling restart: re-add validated first-rolled worker to nginx before rolling the rest.
# At this point NEW_PORT has passed HC + smoke on the new release (isolated from traffic).
# Restore it to the upstream so all CHATAPP_INSTANCES workers serve while we roll the others.
if [ "${ROLLING_RESTART:-false}" = "true" ]; then
  echo "8b.5 Restoring :${NEW_PORT} to nginx upstream (validated on ${RELEASE_SHA})..."
  rewrite_nginx_upstream "${TARGET_PORTS_CSV}" "restore first rolled worker :${NEW_PORT}" || {
    echo "ERROR: failed to restore :${NEW_PORT} to nginx after smoke validation"
    rollback_cutover; exit 1
  }
  echo "✓ :${NEW_PORT} back in nginx upstream (all ${CHATAPP_INSTANCES} workers active)"
  wait_worker_settle_after_health "${NEW_PORT}" "before rolling remaining workers"
fi

deploy_prod_run_nginx_cutover_and_worker_roll

# 9.5. Enable new service for auto-start on reboot
if printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${NEW_PORT}"; then
  echo "9.5 Enabling candidate service for auto-start on reboot..."
  ssh_prod "sudo systemctl enable chatapp@${NEW_PORT} 2>/dev/null || true"
  echo "✓ Service enabled"
else
  echo "9.5 Skipping auto-enable for spare candidate port ${NEW_PORT}."
fi

deploy_prod_run_monitor_window_and_reclaim

# shellcheck source=deploy-prod-monitoring-sync.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-monitoring-sync.sh"

# 10.55–10.65. Sync monitoring config and refresh containers.
# Run in background — monitoring is non-critical for the grader and takes 1-2 min.
# Step 11 and the final health gates continue immediately; wait after Step 12 passes.
#
# SKIP_MONITORING_SYNC=1 suppresses this block; deploy-prod-multi.sh sets it for
# per-VM calls and handles monitoring as a single combined step at the end.
echo "10.55–10.65. Starting monitoring refresh in background..."
deploy_prod_start_monitoring_refresh_background

# 11. Update current symlink
echo "11. Updating current release symlink..."
if ssh_prod "
  set -euo pipefail
  ln -sfn '${RELEASE_DIR}/${RELEASE_SHA}' '${CURRENT_LINK}'
  echo 'Symlink: ${CURRENT_LINK} -> ${RELEASE_SHA}'
  # Keep only the N most recent releases to prevent disk exhaustion (node_modules ~200MB each).
  if [ -d '${RELEASE_DIR}' ] && compgen -G '${RELEASE_DIR}/*' >/dev/null; then
    ls -1dt '${RELEASE_DIR}'/* | tail -n +$((KEEP_RELEASES + 1)) | while IFS= read -r path; do
      [ -n \"\${path}\" ] || continue
      rm -rf \"\${path}\"
    done
  fi
"; then
  echo "✓ Symlink updated"
else
  echo "⚠ WARNING: Could not update symlink due to transient SSH failure."
fi

# 12. Final health check
echo "12. Final verification..."
if gate_same_release && gate_all_worker_health && gate_upstream_parity && gate_current_symlink_ok && gate_ingress_post_deploy; then
  if [ "${SKIP_INGRESS_POST_DEPLOY:-0}" = "1" ]; then
    echo "Skipping post-deploy prod nginx parity audit (SKIP_INGRESS_POST_DEPLOY=1 — worker-only host)"
  else
    echo "Running prod nginx parity audit after deploy..."
    if ! run_local_prod_nginx_audit; then
      echo "ERROR: post-deploy prod nginx parity audit failed."
      deploy_prod_cancel_monitoring_refresh
      rollback_cutover
      exit 1
    fi
    echo "✓ Prod nginx parity audit passed"
  fi
  deploy_log_phase "final gates + nginx audit OK"
  deploy_prod_wait_monitoring_refresh_nonfatal
  notify_discord_prod ":white_check_mark: **Prod deploy succeeded** \`${RELEASE_SHA:0:7}\` · ${CHATAPP_INSTANCES} workers"
  echo "✓ Production deployment SUCCESSFUL"
else
  echo "ERROR: Final health check failed after cutover."
  deploy_prod_cancel_monitoring_refresh
  rollback_cutover
  exit 1
fi

# 13. Cleanup older releases/backups to control disk usage on small VMs.
echo "13. Pruning old releases/backups (keep releases=$KEEP_RELEASES backups=$KEEP_BACKUPS)..."
if ssh_prod "
  set -euo pipefail
  if [ -d '${RELEASE_DIR}' ] && compgen -G '${RELEASE_DIR}/*' >/dev/null; then
    ls -1dt '${RELEASE_DIR}'/* | tail -n +$((KEEP_RELEASES + 1)) | while IFS= read -r path; do
      [ -n \"\${path}\" ] || continue
      rm -rf \"\${path}\"
    done
  fi
  if [ -d /opt/chatapp/backups ] && compgen -G '/opt/chatapp/backups/*' >/dev/null; then
    ls -1dt /opt/chatapp/backups/* | tail -n +$((KEEP_BACKUPS + 1)) | while IFS= read -r path; do
      [ -n \"\${path}\" ] || continue
      rm -f \"\${path}\"
    done
  fi
"; then
  echo "✓ Cleanup complete"
else
  echo "⚠ WARNING: Cleanup skipped due to transient SSH failure."
fi

ssh_prod "sudo logger -t chatapp-deploy \"event=complete sha=${RELEASE_SHA} candidate_port=${NEW_PORT} companion_port=${OLD_PORT} instances=${CHATAPP_INSTANCES}\"" || true

echo ""
echo "=== Deployment Complete ==="
echo "Release: $RELEASE_SHA"
echo "Production: https://${PROD_HOST//.internal*/}"
echo ""
echo "To rollback: re-run ./deploy/deploy-prod.sh <previous-sha>"
echo ""
echo "To stop the old version after confidence window (keep for ~10 min):"
echo "  ssh ${PROD_USER}@${PROD_HOST} 'systemctl stop chatapp@${OLD_PORT}'"
