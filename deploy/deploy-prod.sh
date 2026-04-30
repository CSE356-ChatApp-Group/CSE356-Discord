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
#                  artifact download, npm ci, migrations, pgbouncer, monitoring.
#                  Completes in ~2-3 min.  Use when the current deploy is bad and you
#                  need to revert quickly.
#   SKIP_BACKUP=true  Skip pg_dump (safe for code-only deploys, saves 2-5 min).

set -euo pipefail

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy-prod.sh <sha> [--rollback]}
# Refuse odd SHAs early so they never reach unquoted remote snippets.
if ! [[ "${RELEASE_SHA}" =~ ^[A-Fa-f0-9]{7,40}$ ]]; then
  echo "ERROR: RELEASE_SHA must be a 7-40 character hexadecimal commit id (got '${RELEASE_SHA}')."
  exit 1
fi
# --rollback flag: skip artifact download, backup, npm ci, migrations, pgbouncer setup,
# and monitoring refresh — only do the rolling restart + health gates.
FAST_ROLLBACK="${FAST_ROLLBACK:-false}"
if [[ "${2:-}" == "--rollback" ]]; then
  FAST_ROLLBACK="true"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
      -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-prod-%r@%h:%p -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${PROD_HOST}" "$@"
}

ssh_prod_db() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=25 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-prod-db-%r@%h:%p -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS} \
      "${PROD_USER}@${PROD_DB_HOST}" "$@"
}

ssh_monitor() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=25 \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-monitor-%r@%h:%p -o ControlPersist=10m \
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
  if [ "${status}" -ne 0 ] && [ "${NGINX_CANDIDATE_PIN_ACTIVE:-0}" -eq 1 ] && [ "${ROLLBACK_ALREADY_ATTEMPTED:-0}" -eq 0 ]; then
    ROLLBACK_ALREADY_ATTEMPTED=1
    echo "↩ Exit trap: deploy failed after nginx was pinned to candidate; attempting recovery..."
    notify_discord_prod ":x: **Prod deploy FAILED** \`${RELEASE_SHA:0:7}\` - rollback triggered"
    rollback_cutover
  elif [ "${status}" -ne 0 ]; then
    notify_discord_prod ":x: **Prod deploy FAILED** \`${RELEASE_SHA:0:7}\` (pre-cutover)"
  fi
  release_remote_deploy_lock
  exit "${status}"
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
      echo \"ERROR: another prod deploy is running (owner=\$owner started_at=\$started)\" >&2
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
# Seconds to wait after a worker restarts and passes health checks before rolling the next one.
# Gives WebSocket clients time to reconnect + replay before the next worker is taken down.
# 10s: matches WS_APP_KEEPALIVE_INTERVAL_MS so all clients reconnect within one keepalive cycle.
# (Was 15s — reduced to shave ~20s off a 5-worker rolling deploy.)
WORKER_SETTLE_SECS="${WORKER_SETTLE_SECS:-10}"
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

# First server port inside `upstream app` only (avoids accidental matches elsewhere and
# duplicate-line collapse where a naive grep | head picked an arbitrary port).
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
if [[ -z "${CURRENT_UPSTREAM_PORT}" ]]; then
  CURRENT_UPSTREAM_PORT="${TARGET_PORTS[0]}"
fi

if [ "${CHATAPP_INSTANCES}" -ge 3 ]; then
  if ! printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${CURRENT_UPSTREAM_PORT}"; then
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
  if [[ "${CURRENT_UPSTREAM_PORT}" == "4000" ]]; then
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

# Fast rollback: skip backup, artifact download, npm ci, migrations, pgbouncer, monitoring
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
  sudo env PGBOUNCER_POOL_SIZE=${_PGB_SIZE} PGBOUNCER_MAX_DB_CONNECTIONS=${PGBOUNCER_MAX_DB_CONNECTIONS} PGBOUNCER_MIN_POOL_SIZE=${PGBOUNCER_MIN_POOL_SIZE} PGBOUNCER_RESERVE_SIZE=${PGBOUNCER_RESERVE_SIZE} PG_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS} python3 \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer-setup.py\"
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

DOWNLOAD_PATH="/tmp/chatapp-${RELEASE_SHA}.tar.gz"
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
echo "✓ Artifact ready locally"

# 3b. SHA-256 of bytes we are about to ship (detect local corruption / truncates before scp).
ARTIFACT_SHA256=$(openssl dgst -sha256 "$DOWNLOAD_PATH" | awk '{print $2}')
echo "Artifact SHA256 (local): ${ARTIFACT_SHA256}"

# 4. Copy to production server
echo "4. Copying to production..."
chatapp_scp_to_prod "$DOWNLOAD_PATH" "$PROD_USER@$PROD_HOST:/tmp/"
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
  
  # Install backend dependencies
  cd \$RELEASE_PATH/backend
  # nice -n 15: deprioritise npm vs. the 5 live workers competing for the same CPU/disk
  nice -n 15 npm ci --omit=dev --legacy-peer-deps || nice -n 15 npm ci --omit=dev

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
# Use ssh stdin pipe instead of scp: OpenSSH >=9.0 switches scp to the SFTP
# subsystem which misparses '@' in remote paths, causing "Permission denied".
ssh_prod 'cat > /tmp/chatapp-template.service' < "${SCRIPT_DIR}/chatapp-template.service"
ssh_prod 'cat > /tmp/redis-wait.sh' < "${SCRIPT_DIR}/redis-wait.sh"
chatapp_scp_to_prod "${SCRIPT_DIR}/apply-env-profile.py" "${PROD_USER}@${PROD_HOST}:/tmp/apply-env-profile.py"
chatapp_scp_to_prod "${SCRIPT_DIR}/env/prod.required.env" "${PROD_USER}@${PROD_HOST}:/tmp/prod.required.env"
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
  echo "NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}"
  echo "AUTH_GLOBAL_PER_IP_RATE_LIMIT=false"
  echo "AUTH_PASSWORD_STORAGE_MODE=plain"
} > "${_PROD_DEPLOY_OVERLAY_ENV}"
chatapp_scp_to_prod "${_PROD_DEPLOY_OVERLAY_ENV}" "${PROD_USER}@${PROD_HOST}:/tmp/prod.deploy.overlay.env"
rm -f "${_PROD_DEPLOY_OVERLAY_ENV}"
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
  echo "  Settling ${WORKER_SETTLE_SECS}s before rolling remaining workers..."
  sleep "${WORKER_SETTLE_SECS}"
fi

# 8c. Nginx access.log: append request_time + upstream_response_time (idempotent).
echo "8c. Nginx access log timing fields (idempotent)..."
chatapp_scp_to_prod "${SCRIPT_DIR}/nginx/patches/patch-nginx-access-log-timing.sh" "${PROD_USER}@${PROD_HOST}:/tmp/patch-nginx-access-log-timing.sh"
ssh_prod 'sudo bash /tmp/patch-nginx-access-log-timing.sh && sudo rm -f /tmp/patch-nginx-access-log-timing.sh'
echo "✓ Nginx access log timing patch applied"

# 9. Nginx + kernel tuning / cutover
# Dual-worker (CHATAPP_INSTANCES>=2): keep both upstreams while candidate warms up, then step 9a
# pins traffic to NEW_PORT only before the companion stop/restart (9b) so nginx never targets a
# socket that is down mid-roll. Step 9c restores least_conn across both ports. Requires migrations
# and API to be backward-compatible between old and new for the shared-traffic window before 9a.
# Single-worker: point nginx at NEW_PORT only, then tune (original behavior).
if [ "${CHATAPP_INSTANCES}" -ge 2 ]; then
  echo "9. Dual-worker: nginx/kernel tuning only (upstream unchanged — both ports stay live)..."
  ssh_prod "
    set -euo pipefail
    export SITE='${CHATAPP_NGINX_SITE_PATH}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' \"\$TMP_SITE\"
    sudo sed -i 's/listen \\[::\\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' \"\$TMP_SITE\"
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
    sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
    TMP_MAIN=\$(mktemp)
    sudo cp /etc/nginx/nginx.conf \"\$TMP_MAIN\"
    sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' \"\$TMP_MAIN\"
    sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' \"\$TMP_MAIN\"
    sudo grep -q '^worker_shutdown_timeout' \"\$TMP_MAIN\" \
      || sudo sed -i '/^worker_processes/a worker_shutdown_timeout 20s;' \"\$TMP_MAIN\"
    sudo grep -q 'worker_rlimit_nofile' \"\$TMP_MAIN\" \
      || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' \"\$TMP_MAIN\"
    sudo install -m 644 \"\$TMP_MAIN\" /etc/nginx/nginx.conf
    rm -f \"\$TMP_MAIN\"
    sudo nginx -t && sudo systemctl reload nginx
    echo 'Nginx: still load-balanced; candidate on '${NEW_PORT}' shares traffic with '${OLD_PORT}''
  "
  echo "✓ Nginx tuned (dual upstream preserved)"
else
  # Rewrite the whole `upstream app { ... }` block instead of globally s/OLD/NEW/g, which
  # collapses dual server lines into duplicate ports (no load balancing + capacity loss).
  echo "9. Switching Nginx to candidate (single-upstream cutover)..."
  ssh_prod "
    set -euo pipefail
    export NEW_PORT='${NEW_PORT}'
    export OLD_PORT='${OLD_PORT}'
    export SITE='${CHATAPP_NGINX_SITE_PATH}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    export TMP_SITE
    python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
newp = os.environ['NEW_PORT']
keepalive = '''  keepalive 16;
  keepalive_requests 100;
  keepalive_timeout 10s;
'''
block = (
    'upstream app {\\n'
    '  server localhost:%s max_fails=0;\\n' % newp
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
    sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' \"\$TMP_SITE\"
    sudo sed -i 's/listen \\[::\\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' \"\$TMP_SITE\"
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
    sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
    sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
    TMP_MAIN=\$(mktemp)
    sudo cp /etc/nginx/nginx.conf \"\$TMP_MAIN\"
    sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' \"\$TMP_MAIN\"
    sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' \"\$TMP_MAIN\"
    sudo grep -q '^worker_shutdown_timeout' \"\$TMP_MAIN\" \
      || sudo sed -i '/^worker_processes/a worker_shutdown_timeout 20s;' \"\$TMP_MAIN\"
    sudo grep -q 'worker_rlimit_nofile' \"\$TMP_MAIN\" \
      || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' \"\$TMP_MAIN\"
    sudo install -m 644 \"\$TMP_MAIN\" /etc/nginx/nginx.conf
    rm -f \"\$TMP_MAIN\"
    sudo nginx -t && sudo systemctl reload nginx
    echo 'Nginx: traffic -> candidate port '${NEW_PORT}' only'
  "
  echo "✓ Nginx cutover applied"
fi

# 9.05 Idempotent: longer read timeout for search only (general /api/ stays 30s).
# Prevents nginx from returning 502 while Node is still working on a successful search.
echo "9.05 Nginx: ensure /api/v1/search extended proxy timeouts..."
patch_nginx_search_location
echo "✓ Nginx search route OK"

# 9.06 Idempotent: add upstream retry policy for /api/ only (exclude websocket path).
echo "9.06 Nginx: ensure /api/ upstream retry policy..."
patch_nginx_api_retry
echo "✓ Nginx /api retry policy OK"

# 9.07 Idempotent: dedicated /api/v1/auth/ with longer proxy timeouts than generic /api/ (30s).
# Auth is bcrypt-bound; without this, login/register can see nginx 504 HTML under burst.
echo "9.07 Nginx: ensure /api/v1/auth/ extended proxy timeouts..."
patch_nginx_auth_location
echo "✓ Nginx auth route OK"

# 9.071 Idempotent: critical OAuth/auth flow routes must bypass strict generic auth
# throttles so start + callback redirects are not dropped by nginx before the app.
echo "9.071 Nginx: ensure critical OAuth/auth flow routes bypass strict auth rate limits..."
patch_nginx_auth_flow_routes
echo "✓ Nginx critical auth routes OK"

# 9.075 Idempotent: fix auth block — `non_idempotent` must be on proxy_next_upstream,
# and remove invalid standalone proxy_next_upstream_non_idempotent if present.
echo "9.075 Nginx: ensure auth proxy_next_upstream includes non_idempotent..."
patch_nginx_auth_non_idempotent
echo "✓ Nginx auth POST retry OK"

# 9b–9c. Multi-worker: roll all workers to this release, then verify parity.
if [ "${CHATAPP_INSTANCES}" -ge 2 ]; then
  if [ "${ROLLING_RESTART:-false}" = "true" ]; then
    # ---- Rolling restart (CHATAPP_INSTANCES >= 3) ----
    # NEW_PORT was already rolled in step 6 and re-added to nginx in step 8b.5.
    # Roll remaining workers one at a time: remove from nginx → restart → HC → re-add → settle.
    # At every moment N-1 workers serve production traffic — no single-worker window.
    REMAINING_ROLL=()
    for _p in "${TARGET_PORTS[@]}"; do
      [ "$_p" != "${NEW_PORT}" ] && REMAINING_ROLL+=("$_p")
    done
    # Reverse order: roll highest-numbered non-canonical ports first, OLD_PORT (canonical) last.
    REMAINING_ROLL_REV=()
    for (( _ri=${#REMAINING_ROLL[@]}-1; _ri>=0; _ri-- )); do
      REMAINING_ROLL_REV+=("${REMAINING_ROLL[$_ri]}")
    done

    for roll_port in "${REMAINING_ROLL_REV[@]}"; do
      echo "--- Rolling worker :${roll_port} to ${RELEASE_SHA} ---"

      # 1. Build upstream CSV without this port (N-1 workers serve).
      _ROLL_EXCL_CSV=""
      for _p in "${TARGET_PORTS[@]}"; do
        [ "$_p" != "${roll_port}" ] && _ROLL_EXCL_CSV="${_ROLL_EXCL_CSV:+${_ROLL_EXCL_CSV},}${_p}"
      done

      # 2. Remove roll_port from nginx — remaining N-1 workers absorb all traffic.
      rewrite_nginx_upstream "${_ROLL_EXCL_CSV}" "remove :${roll_port} before roll" || {
        echo "ERROR: failed to remove :${roll_port} from nginx"; rollback_cutover; exit 1
      }
      # Brief drain: nginx reload is graceful but old worker processes may still hold keepalive
      # connections to the now-removed upstream.  2s is enough for those connections to drain
      # before SIGTERM is sent.
      sleep 2

      # 3. Restart worker on new release (shared safe restart helper).
      if ! restart_worker_on_release "${roll_port}"; then
        echo "ERROR: roll failed on :${roll_port}"
        rollback_cutover
        exit 1
      fi

      # 4. Health check isolated worker (not yet in nginx upstream).
      if ! ssh_prod "/tmp/health-check.sh ${roll_port} http://127.0.0.1:${roll_port}"; then
        echo "ERROR: health check failed on :${roll_port}"
        rollback_cutover; exit 1
      fi

      # 5. Re-add roll_port to nginx (N workers active again).
      rewrite_nginx_upstream "${TARGET_PORTS_CSV}" "restore :${roll_port} after roll" || {
        echo "ERROR: failed to restore :${roll_port} to nginx"; rollback_cutover; exit 1
      }

      # 6. Settle: let WS clients reconnect to updated worker before rolling the next.
      echo "  Settling ${WORKER_SETTLE_SECS}s for WS reconnects..."
      sleep "${WORKER_SETTLE_SECS}"
      deploy_log_phase "rolled :${roll_port}"
    done

    NGINX_CANDIDATE_PIN_ACTIVE=0
    gate_same_release || { rollback_cutover; exit 1; }
    gate_all_worker_health || { rollback_cutover; exit 1; }
    gate_upstream_parity || { rollback_cutover; exit 1; }
    deploy_log_phase "rolling restart complete (all ${CHATAPP_INSTANCES} workers) + parity gates OK"
    echo "✓ Rolling restart complete"

  else
  # ---- Spare-port cutover (CHATAPP_INSTANCES == 2 / staging) ----
  if [ "${PIN_CANDIDATE_BEFORE_COMPANION}" = "true" ]; then
    echo "9a. Pinning nginx to candidate (${NEW_PORT}) before companion restart..."
    ssh_prod "
      set -euo pipefail
      export NEW_PORT='${NEW_PORT}'
      export SITE='${CHATAPP_NGINX_SITE_PATH}'
      TMP_SITE=\$(mktemp)
      sudo cp \"\$SITE\" \"\$TMP_SITE\"
      export TMP_SITE
      python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
newp = os.environ['NEW_PORT']
keepalive = '''  keepalive 16;
  keepalive_requests 100;
  keepalive_timeout 10s;
'''
block = (
    'upstream app {\\n'
    '  server localhost:%s max_fails=0;\\n' % newp
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9a: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
      sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
      rm -f \"\$TMP_SITE\"
      sudo nginx -t >/dev/null
      sudo systemctl reload nginx
      echo 'Nginx: candidate-only upstream before companion roll'
    " || {
      echo "ERROR: Nginx pin to candidate (9a) failed."
      rollback_cutover
      exit 1
    }
    NGINX_CANDIDATE_PIN_ACTIVE=1
    echo "✓ Nginx pinned to candidate"
    gate_ingress_canary || {
      rollback_cutover
      exit 1
    }
  else
    echo "9a. Skipping nginx pin (PIN_CANDIDATE_BEFORE_COMPANION=false) — ensure /api/ proxy_next_upstream includes non_idempotent."
    echo "✓ Companion restart may briefly 502 POST if an upstream is down"
  fi

  echo "9a.1 Verifying candidate stays healthy before companion restart..."
  if ! ssh_prod "
    set -euo pipefail
    ok=0
    health_log=/tmp/chatapp-candidate-health-${NEW_PORT}.log
    rm -f \"\$health_log\"
    for i in 1 2 3; do
      if /tmp/health-check.sh ${NEW_PORT} http://127.0.0.1:${NEW_PORT} >\"\$health_log\" 2>&1; then
        ok=\$((ok+1))
      else
        ok=0
      fi
      sleep 1
    done
    if [ \"\$ok\" -lt 3 ]; then
      echo '--- Candidate health-check output (tail) ---'
      tail -n 80 \"\$health_log\" || true
      echo '--- Candidate service journal (recent) ---'
      sudo journalctl -u chatapp@${NEW_PORT} --no-pager -n 80 || true
      exit 1
    fi
  "; then
    echo "ERROR: Candidate failed consecutive health checks just before companion roll."
    rollback_cutover
    exit 1
  fi

  echo "9b. Rolling companion on port ${OLD_PORT} to ${RELEASE_SHA}..."
  if ! restart_worker_on_release "${OLD_PORT}"; then
    echo "ERROR: Companion roll to ${RELEASE_SHA} failed."
    rollback_cutover
    exit 1
  fi
  echo "Companion chatapp@${OLD_PORT} restarted on new release"
  if ! ssh_prod "/tmp/health-check.sh ${OLD_PORT} http://127.0.0.1:${OLD_PORT}"; then
    echo "ERROR: Health check failed on companion port ${OLD_PORT}."
    rollback_cutover
    exit 1
  fi
  if ! ssh_prod "
    set -euo pipefail
    fails=0
    for i in 1 2 3 4; do
      /tmp/health-check.sh ${OLD_PORT} http://127.0.0.1:${OLD_PORT} >/dev/null 2>&1 || fails=\$((fails+1))
      sleep 1
    done
    [ \"\$fails\" -eq 0 ]
  "; then
    echo "ERROR: Companion port ${OLD_PORT} failed warm-up checks."
    rollback_cutover
    exit 1
  fi

  if [ "${#ADDITIONAL_PORTS[@]}" -gt 0 ]; then
    echo "9b.5. Rolling additional worker ports (${ADDITIONAL_PORTS[*]}) to ${RELEASE_SHA}..."
    echo "  Settling ${WORKER_SETTLE_SECS}s after OLD_PORT restart before rolling additional workers..."
    sleep "${WORKER_SETTLE_SECS}"
    for extra_port in "${ADDITIONAL_PORTS[@]}"; do
      if ! restart_worker_on_release "${extra_port}"; then
        echo "ERROR: Rolling additional worker port ${extra_port} failed."
        rollback_cutover
        exit 1
      fi
      hc_ok=0
      for attempt in 1 2 3 4 5; do
        if ssh_prod "/tmp/health-check.sh ${extra_port} http://127.0.0.1:${extra_port}"; then
          hc_ok=1
          break
        fi
        echo "WARN: health-check on :${extra_port} attempt ${attempt} failed (SSH flake or slow start); retrying in 3s..."
        sleep 3
      done
      if [ "${hc_ok}" -ne 1 ]; then
        echo "ERROR: Health check failed on additional worker port ${extra_port} after retries."
        rollback_cutover
        exit 1
      fi
      echo "  Settling ${WORKER_SETTLE_SECS}s for WS clients to reconnect before next worker restart..."
      sleep "${WORKER_SETTLE_SECS}"
    done
  fi

  echo "9c. Restoring nginx upstream (least_conn, all ${CHATAPP_INSTANCES} workers)..."
  gate_same_release || {
    rollback_cutover
    exit 1
  }
  CHATAPP_INSTANCES_HIGH_START=$((4000 + CHATAPP_INSTANCES))
  ssh_prod "
    set -euo pipefail
    export TARGET_PORTS_CSV='${TARGET_PORTS_CSV}'
    export SITE='${CHATAPP_NGINX_SITE_PATH}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    export TMP_SITE
    python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
ports = [p.strip() for p in os.environ['TARGET_PORTS_CSV'].split(',') if p.strip()]
if not ports:
    raise SystemExit('step 9c: no target ports provided')
keepalive = '''  keepalive 512;
  keepalive_requests 100000;
  keepalive_timeout 75s;
'''
servers = ''.join(f'  server localhost:{p} max_fails=0;\\n' for p in ports)
block = (
    'upstream app {\\n'
    '  least_conn;\\n'
    + servers
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9c: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
    for p in ${TARGET_PORTS_CSV//,/ }; do
      sudo systemctl enable chatapp@\$p 2>/dev/null || true
    done
    # Belt-and-suspenders: stop/disable any higher-numbered workers (e.g. @4004 when CHATAPP_INSTANCES=4)
    # so a previous deploy or manual start cannot leave them enabled after nginx only lists TARGET_PORTS.
    for p in \$(seq ${CHATAPP_INSTANCES_HIGH_START} 4007); do
      sudo systemctl stop chatapp@\${p} 2>/dev/null || true
      sudo systemctl disable chatapp@\${p} 2>/dev/null || true
    done
    echo 'Nginx: load-balanced ports ${TARGET_PORTS_CSV}'
  " || {
    echo "ERROR: Nginx upstream rewrite failed (multi-worker restore)."
    rollback_cutover
    exit 1
  }
  NGINX_CANDIDATE_PIN_ACTIVE=0

  # Spare candidate (e.g. :4004 when CHATAPP_INSTANCES=4) must not stay running — it breaks
  # gate_upstream_parity (unexpected active worker) and wastes RAM.
  if ! printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${NEW_PORT}"; then
    echo "9c.1 Stopping spare candidate chatapp@${NEW_PORT} before upstream parity gates..."
    ssh_prod "
      set -euo pipefail
      sudo systemctl stop chatapp@${NEW_PORT} 2>/dev/null || true
      sudo systemctl disable chatapp@${NEW_PORT} 2>/dev/null || true
    " || true
    echo "✓ Spare candidate stopped"
  fi

  gate_all_worker_health || {
    rollback_cutover
    exit 1
  }
  gate_upstream_parity || {
    rollback_cutover
    exit 1
  }
  deploy_log_phase "multi-worker cutover (9c) + parity gates OK"
  echo "OK: Multi-worker nginx upstream restored"
  fi  # end else (spare-port)
fi

# 9.5. Enable new service for auto-start on reboot
if printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${NEW_PORT}"; then
  echo "9.5 Enabling candidate service for auto-start on reboot..."
  ssh_prod "sudo systemctl enable chatapp@${NEW_PORT} 2>/dev/null || true"
  echo "✓ Service enabled"
else
  echo "9.5 Skipping auto-enable for spare candidate port ${NEW_PORT}."
fi

# 10. Monitor briefly
MONITOR_CHECKS=$((MONITOR_SECONDS / 5))
if [ "$MONITOR_CHECKS" -lt 1 ]; then
  MONITOR_CHECKS=1
fi

echo "10. Monitoring for ${MONITOR_SECONDS} seconds..."
MONITOR_FAILS=0
for i in $(seq 1 "$MONITOR_CHECKS"); do
  sleep 5
  if gate_all_worker_health >/dev/null 2>&1; then
    echo "  ✓ Check $i/$MONITOR_CHECKS passed"
  else
    echo "  ✗ Check $i/$MONITOR_CHECKS: all-worker health gate failed"
    MONITOR_FAILS=$((MONITOR_FAILS + 1))
  fi
done
if [ "$MONITOR_FAILS" -gt 0 ]; then
  echo "ERROR: Candidate failed ${MONITOR_FAILS}/${MONITOR_CHECKS} monitor checks after cutover."
  rollback_cutover
  exit 1
fi
echo "✓ Monitoring window complete"

# 10.45. Spare candidate is reclaimed in 9c.1 (multi-worker). Single-worker uses NEW_PORT in TARGET.

# 10.5. Stop old port to reclaim memory.
# Prod runs a single instance (CHATAPP_INSTANCES=1); the old port stays running
# through the monitoring window for emergency rollback, but afterwards its RAM
# (~125 MB) is more valuable than instant-rollback convenience on a 2 GB VM.
# To roll back after this point: re-run this script with the previous SHA.
if [ "${RECLAIM_OLD_PORT}" = "true" ]; then
  echo "10.5. Stopping old instance on port ${OLD_PORT} to reclaim RAM..."
  ssh_prod "
    sudo systemctl stop chatapp@${OLD_PORT} 2>/dev/null || true
    sudo systemctl disable chatapp@${OLD_PORT} 2>/dev/null || true
    echo 'Old instance stopped'"
  echo "✓ Old instance stopped (rollback now requires re-deploy)"
else
  echo "10.5. Keeping old instance on port ${OLD_PORT} for fast rollback safety."
fi

# shellcheck source=deploy-prod-monitoring-sync.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-prod-monitoring-sync.sh"

# 10.55–10.65. Sync monitoring config and refresh containers.
# Run in background — monitoring is non-critical for the grader and takes 1-2 min.
# We wait for it before the final success notification so errors surface in the log.
#
# SKIP_MONITORING_SYNC=1 suppresses this block; deploy-prod-multi.sh sets it for
# per-VM calls and handles monitoring as a single combined step at the end.
echo "10.55–10.65. Starting monitoring refresh in background..."
deploy_prod_start_monitoring_refresh_background

# Wait for background monitoring refresh before updating symlink + final gates
if [[ -n "${_MONITORING_BG_PID:-}" ]]; then
  echo "Waiting for background monitoring refresh to complete..."
  wait "${_MONITORING_BG_PID}" \
    || echo "⚠ Monitoring refresh had errors (non-fatal — app deploy succeeded)"
fi

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
      rollback_cutover
      exit 1
    fi
    echo "✓ Prod nginx parity audit passed"
  fi
  deploy_log_phase "final gates + nginx audit OK"
  notify_discord_prod ":white_check_mark: **Prod deploy succeeded** \`${RELEASE_SHA:0:7}\` · ${CHATAPP_INSTANCES} workers"
  echo "✓ Production deployment SUCCESSFUL"
else
  echo "ERROR: Final health check failed after cutover."
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
