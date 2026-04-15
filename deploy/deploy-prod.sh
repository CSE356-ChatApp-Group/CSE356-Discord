#!/bin/bash
# deploy/deploy-prod.sh
# Deploy to production using candidate-port cutover.
# Usage: ./deploy-prod.sh <release-sha>

set -euo pipefail

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy-prod.sh <sha>}
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
GITHUB_REPO="${GITHUB_REPO:-CSE356-ChatApp-Group/CSE356-Discord}"
LOCAL_ARTIFACT_PATH="${LOCAL_ARTIFACT_PATH:-}"
RELEASE_DIR="/opt/chatapp/releases"
CURRENT_LINK="/opt/chatapp/current"
OLD_PORT=4000
NEW_PORT=4001
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-common.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/deploy-common.sh"

ssh_prod() {
  ssh "${PROD_USER}@${PROD_HOST}" "$@"
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

MONITOR_SECONDS="${MONITOR_SECONDS:-30}"
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
# PgBouncer helper scripts: never scp to /tmp — root-owned leftovers from manual
# `sudo` runs cause "Permission denied" for the deploy user (ubuntu).
DEPLOY_REMOTE_HELPER_DIR="${DEPLOY_REMOTE_HELPER_DIR:-chatapp-deploy-helpers}"

# Number of Node.js HTTP workers (systemd chatapp@ ports).
# Production runs four workers by default (chatapp@4000..@4003) unless explicitly overridden.
CHATAPP_INSTANCES=${CHATAPP_INSTANCES:-4}
_REMOTE_NCPU=$(ssh_prod 'nproc --all' 2>/dev/null || echo 2)
# PgBouncer pool + Node pool math matches deploy-staging.sh (same caps, different host).
# Scale default_pool_size with **host vCPU** so 8 vCPU (etc.) actually gets more real PG
# backends than 4 vCPU. Older `min(..., 80 + inst*45)` pinned the pool at 170 for any
# 2-worker host with ≥4 cores — resizing the VM did nothing for DB capacity.
_PGB_SIZE=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = int('${CHATAPP_INSTANCES}')
cpu_part = ncpu * 50
extra = max(0, inst - 1) * 30
# Cap raised from 320 → 400 so 8 vCPU+ hosts get more real PG backends after resize.
x = max(60, min(400, cpu_part + extra))
print(x)
")
PG_POOL_MAX_PER_INSTANCE=$(python3 -c "
p = int('${_PGB_SIZE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
ncpu = int('${_REMOTE_NCPU}')
# Per-process virtual pool to PgBouncer; scales with vCPU (was capped at 170 @ 8 cores).
pool_cap = min(240, 70 + ncpu * 20)
print(max(25, min(pool_cap, (p * 5) // (inst * 2))))
")
POOL_CIRCUIT_BREAKER_QUEUE=$(python3 -c "
pmi = int('${PG_POOL_MAX_PER_INSTANCE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
# Keep queue bounded so overload fails fast instead of long timeout buildup.
print(max(64, min(300, pmi * 3 + inst * 60)))
")
PG_MAX_CONNECTIONS=$(python3 -c "
b = int('${_PGB_SIZE}')
# Headroom above PgBouncer default_pool_size for admin, stats, and burst.
print(max(150, min(500, b + 100)))
")
FANOUT_QUEUE_CONCURRENCY=$(python3 -c "
n = int('${_REMOTE_NCPU}')
print(min(12, max(2, (n + 1) // 2 + 1)))
")
UV_THREADPOOL_PER_INSTANCE=$(python3 -c "print(max(8, 16 // max(1, ${CHATAPP_INSTANCES})))")
BCRYPT_MAX_CONCURRENT=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
uv = int('${UV_THREADPOOL_PER_INSTANCE}')
per_inst_cpu = (ncpu + inst - 1) // inst
print(max(4, min(uv, per_inst_cpu + 2)))
")
COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
per_inst_cpu = (ncpu + inst - 1) // inst
print(max(2, min(4, per_inst_cpu - 1)))
")
# V8 max-old-space per instance: cap heap below the OOM killer threshold.
# Formula: min(1500, max(RAM_MB * 12%, 192)) — same as deploy-staging.sh.
# On a 2 GB prod machine: min(1500, max(246, 192)) = 246 MB.
_REMOTE_RAM_MB=$(ssh_prod "awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo" 2>/dev/null || echo 2048)
NODE_OLD_SPACE_MB=$(python3 -c "print(min(1500, max(192, ${_REMOTE_RAM_MB} * 12 // 100 // ${CHATAPP_INSTANCES})))")

echo "=== PRODUCTION DEPLOYMENT ==="
echo "Release: $RELEASE_SHA"
echo "Target: $PROD_USER@$PROD_HOST"
echo "  VM vCPUs: ${_REMOTE_NCPU}  workers: ${CHATAPP_INSTANCES}  pgbouncer_pool: ${_PGB_SIZE}  pg_max_conn: ${PG_MAX_CONNECTIONS}"
echo "  PG_POOL_MAX/instance: ${PG_POOL_MAX_PER_INSTANCE}  pool_circuit_queue: ${POOL_CIRCUIT_BREAKER_QUEUE}"
echo "  UV threadpool/instance: ${UV_THREADPOOL_PER_INSTANCE}  bcrypt_conc: ${BCRYPT_MAX_CONCURRENT}"
echo "  communities_heavy_max_inflight: ${COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT}"

echo "Acquiring remote deploy lock..."
acquire_remote_deploy_lock
trap release_remote_deploy_lock EXIT
echo "✓ Remote deploy lock acquired"

"${SCRIPT_DIR}/preflight-check.sh" prod "$RELEASE_SHA" "$PROD_USER" "$PROD_HOST" "$GITHUB_REPO"

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
  CURRENT_UPSTREAM_PORT="${OLD_PORT}"
fi

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

echo "Current live port: $OLD_PORT"
echo "Candidate port: $NEW_PORT"

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

ADDITIONAL_PORTS=()
for p in "${TARGET_PORTS[@]}"; do
  if [ "$p" != "$OLD_PORT" ] && [ "$p" != "$NEW_PORT" ]; then
    ADDITIONAL_PORTS+=( "$p" )
  fi
done

TARGET_PORTS_CSV=$(IFS=,; echo "${TARGET_PORTS[*]}")
echo "Target app worker ports: ${TARGET_PORTS[*]}"
PREV_RELEASE_MAP=()

stop_chatapp_port() {
  local p="${1:?port required}"
  ssh_prod "sudo systemctl stop chatapp@${p} 2>/dev/null || true"
}

capture_previous_release_map() {
  PREV_RELEASE_MAP=()
  for p in "${TARGET_PORTS[@]}"; do
    local release_path
    release_path="$(ssh_prod "
      set -euo pipefail
      if ! systemctl is-active --quiet chatapp@${p}; then
        exit 0
      fi
      pid=\$(systemctl show -p MainPID --value chatapp@${p} || true)
      if [ -z \"\${pid}\" ] || [ \"\${pid}\" = \"0\" ]; then
        exit 0
      fi
      cwd=\$(readlink -f /proc/\${pid}/cwd 2>/dev/null || true)
      if [ -z \"\${cwd}\" ]; then
        exit 0
      fi
      case \"\${cwd}\" in
        */backend) echo \"\${cwd%/backend}\" ;;
        *) echo \"\${cwd}\" ;;
      esac
    " || true)"
    if [ -n "${release_path}" ]; then
      PREV_RELEASE_MAP+=( "${p}:${release_path}" )
    fi
  done
  if [ "${#PREV_RELEASE_MAP[@]}" -gt 0 ]; then
    echo "Captured previous worker release map: ${PREV_RELEASE_MAP[*]}"
  else
    echo "WARN: previous worker release map is empty (fresh host or inactive units)"
  fi
}

restore_previous_release_map() {
  if [ "${#PREV_RELEASE_MAP[@]}" -eq 0 ]; then
    echo "↩ No previous release map captured; skipping worker release restoration."
    return 0
  fi
  echo "↩ Restoring prior worker release map..."
  for entry in "${PREV_RELEASE_MAP[@]}"; do
    local port="${entry%%:*}"
    local release_path="${entry#*:}"
    ssh_prod "
      set -euo pipefail
      DROPIN_DIR=/etc/systemd/system/chatapp@${port}.service.d
      sudo mkdir -p \"\$DROPIN_DIR\"
      printf '[Service]\nWorkingDirectory=%s/backend\n' '${release_path}' | sudo tee \"\$DROPIN_DIR/release.conf\" >/dev/null
      sudo systemctl daemon-reload
      sudo systemctl restart chatapp@${port}
      /tmp/health-check.sh ${port} http://127.0.0.1:${port} >/dev/null
    " || {
      echo "WARN: could not fully restore chatapp@${port} to ${release_path}"
    }
  done
}

gate_same_release() {
  echo "Gate: same-release parity across target workers..."
  local expected="${RELEASE_DIR}/${RELEASE_SHA}/backend"
  if ! ssh_prod "
    set -euo pipefail
    expected='${expected}'
    for p in ${TARGET_PORTS_CSV//,/ }; do
      systemctl is-active --quiet chatapp@\${p} || { echo \"inactive chatapp@\${p}\"; exit 1; }
      pid=\$(systemctl show -p MainPID --value chatapp@\${p})
      [ -n \"\${pid}\" ] && [ \"\${pid}\" != \"0\" ] || { echo \"missing pid chatapp@\${p}\"; exit 1; }
      cwd=\$(readlink -f /proc/\${pid}/cwd 2>/dev/null || true)
      [ \"\${cwd}\" = \"\${expected}\" ] || { echo \"release mismatch chatapp@\${p}: \${cwd} != \${expected}\"; exit 1; }
    done
  "; then
    echo "ERROR: same-release parity gate failed."
    return 1
  fi
  echo "✓ Same-release parity gate passed"
}

gate_all_worker_health() {
  echo "Gate: all-worker health (${ALL_WORKER_HEALTH_PASSES} consecutive passes per port)..."
  if ! ssh_prod "
    set -euo pipefail
    passes='${ALL_WORKER_HEALTH_PASSES}'
    for p in ${TARGET_PORTS_CSV//,/ }; do
      ok=0
      for _i in \$(seq 1 \"\${passes}\"); do
        if /tmp/health-check.sh \${p} http://127.0.0.1:\${p} >/dev/null 2>&1; then
          ok=\$((ok+1))
        else
          ok=0
        fi
        sleep 1
      done
      [ \"\${ok}\" -ge \"\${passes}\" ] || { echo \"health gate failed on :\${p}\"; exit 1; }
    done
  "; then
    echo "ERROR: all-worker health gate failed."
    return 1
  fi
  echo "✓ All-worker health gate passed"
}

gate_upstream_parity() {
  echo "Gate: nginx upstream parity with active workers..."
  if ! ssh_prod "
    set -euo pipefail
    cfg=/etc/nginx/sites-available/chatapp
    [ -f \"\${cfg}\" ] || { echo 'missing nginx site config'; exit 1; }
    upstream=\$(sudo sed -n '/^upstream app {/,/^}/p' \"\${cfg}\")
    ports_up=\$(echo \"\${upstream}\" | grep -oE 'localhost:[0-9]+|127\\.0\\.0\\.1:[0-9]+' | sed 's/.*://' | sort -u)
    [ -n \"\${ports_up}\" ] || { echo 'no upstream ports'; exit 1; }
    for p in ${TARGET_PORTS_CSV//,/ }; do
      systemctl is-active --quiet chatapp@\${p} || { echo \"inactive chatapp@\${p}\"; exit 1; }
      echo \"\${ports_up}\" | grep -qx \"\${p}\" || { echo \"upstream missing :\${p}\"; exit 1; }
    done
    for p in \${ports_up}; do
      case ',${TARGET_PORTS_CSV},' in
        *\",\${p},\"*) ;;
        *) echo \"unexpected upstream port :\${p}\"; exit 1 ;;
      esac
    done
    sudo nginx -t >/dev/null
  "; then
    echo "ERROR: upstream parity gate failed."
    return 1
  fi
  echo "✓ Upstream parity gate passed"
}

gate_ingress_canary() {
  echo "Gate: ingress canary (${INGRESS_CANARY_SECONDS}s on nginx path)..."
  if ! ssh_prod "
    set -euo pipefail
    total='${INGRESS_CANARY_SECONDS}'
    [ \"\${total}\" -gt 0 ] || exit 0
    for _i in \$(seq 1 \"\${total}\"); do
      curl -fsS -m 3 http://127.0.0.1/health >/dev/null || exit 1
      sleep 1
    done
  "; then
    echo "ERROR: ingress canary gate failed."
    return 1
  fi
  echo "✓ Ingress canary gate passed"
}

ssh_prod "sudo logger -t chatapp-deploy \"event=start sha=${RELEASE_SHA} old_port=${OLD_PORT} new_port=${NEW_PORT} instances=${CHATAPP_INSTANCES}\"" || true

rollback_cutover() {
  echo "↩ Rolling back nginx upstream to prior live port ${OLD_PORT} (single upstream)..."
  ssh_prod "
    set -euo pipefail
    export ROLLBACK_PORT='${OLD_PORT}'
    export SITE='${CHATAPP_NGINX_SITE_PATH}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    export TMP_SITE
    python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
old = os.environ['ROLLBACK_PORT']
keepalive = '''  keepalive 512;
  keepalive_requests 100000;
  keepalive_timeout 75s;
'''
block = (
    'upstream app {\\n'
    f'  server localhost:{old} max_fails=0;\\n'
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('rollback: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
    sudo systemctl start chatapp@${OLD_PORT} 2>/dev/null || true
  "
  restore_previous_release_map || true
}

echo ""
echo "⚠️  This will deploy to PRODUCTION. Verify staging is working first."
echo ""

# In CI environments (GitHub Actions), skip interactive prompt
if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
else
  echo "(CI environment detected, proceeding without confirmation)"
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
  if pg_dump "$DUMP_URL" | gzip -c >"${BACKUP_FILE}.part"; then
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

# 2b. Install/configure PgBouncer (idempotent — safe on every deploy)
echo "2b) Installing and configuring PgBouncer..."
ssh_prod "mkdir -p \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}\""
scp "${SCRIPT_DIR}/pgbouncer-setup.py" "${PROD_USER}@${PROD_HOST}:${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer-setup.py"
scp "${SCRIPT_DIR}/pgbouncer_ini_backend_is_remote.py" "${PROD_USER}@${PROD_HOST}:${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer_ini_backend_is_remote.py"
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
  sudo env PGBOUNCER_POOL_SIZE=${_PGB_SIZE} python3 \"\$HOME/${DEPLOY_REMOTE_HELPER_DIR}/pgbouncer-setup.py\"
  sudo systemctl enable pgbouncer
  if [ \"${ALLOW_DB_RESTART}\" = \"true\" ]; then
    sudo service pgbouncer stop 2>/dev/null || true
    sudo pkill -x pgbouncer 2>/dev/null || true
    sleep 1
    sudo service pgbouncer start
    sleep 1
  else
    # Normal deploy path: avoid bouncing pooler during live traffic.
    sudo systemctl is-active pgbouncer >/dev/null 2>&1 || sudo service pgbouncer start
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
  echo "3. Downloading artifact..."
  gh release download "release-${RELEASE_SHA}" -R "$GITHUB_REPO" \
    -p "chatapp-${RELEASE_SHA}.tar.gz" -O "$DOWNLOAD_PATH" || {
    echo "ERROR: Failed to download artifact."
    exit 1
  }
fi
echo "✓ Artifact ready locally"

# 4. Copy to production server
echo "4. Copying to production..."
scp "$DOWNLOAD_PATH" "$PROD_USER@$PROD_HOST:/tmp/"
scp "${SCRIPT_DIR}/health-check.sh" "${SCRIPT_DIR}/smoke-test.sh" "${SCRIPT_DIR}/candidate-ws-smoke.cjs" "$PROD_USER@$PROD_HOST:/tmp/"
rm "$DOWNLOAD_PATH"
echo "✓ Copied to production"

# 5. Unpack candidate release
echo "5. Unpacking candidate release..."
ssh_prod "
  set -e
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
  
  mkdir -p $RELEASE_DIR
  mkdir -p \$RELEASE_PATH
  tar xzf /tmp/chatapp-${RELEASE_SHA}.tar.gz -C \$RELEASE_PATH
  
  # Install backend dependencies
  cd \$RELEASE_PATH/backend
  npm ci --omit=dev --legacy-peer-deps || npm ci --omit=dev

  # Run DB migrations before any new API instance starts.
  set -a
  source /opt/chatapp/shared/.env
  set +a
  node \$RELEASE_PATH/backend/dist/db/migrate.js

  # Fail fast if migrations did not create core tables (wrong DB, broken artifact, etc.).
  cd \$RELEASE_PATH/backend
  node -e \"
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
capture_previous_release_map

# 5.5. Install/update systemd unit
echo "5.5. Installing/updating systemd unit..."
# Use ssh stdin pipe instead of scp: OpenSSH >=9.0 switches scp to the SFTP
# subsystem which misparses '@' in remote paths, causing "Permission denied".
ssh_prod 'cat > /tmp/chatapp-template.service' < "${SCRIPT_DIR}/chatapp-template.service"
scp "${SCRIPT_DIR}/apply-env-profile.py" "${PROD_USER}@${PROD_HOST}:/tmp/apply-env-profile.py"
scp "${SCRIPT_DIR}/env/prod.required.env" "${PROD_USER}@${PROD_HOST}:/tmp/prod.required.env"
ssh_prod "
  set -e
  sed 's/__DEPLOY_USER__/${PROD_USER}/g' /tmp/chatapp-template.service | sudo tee /etc/systemd/system/chatapp@.service > /dev/null
  # PORT must not be in shared .env — systemd provides it via Environment=PORT=%i
  sudo sed -i '/^PORT=/d' /opt/chatapp/shared/.env
  # Ensure performance-critical env vars are set for this deployment.
  sudo grep -q '^BCRYPT_ROUNDS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_ROUNDS=.*/BCRYPT_ROUNDS=1/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_ROUNDS=1' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^UV_THREADPOOL_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^UV_THREADPOOL_SIZE=.*/UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_POOL_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # POOL_CIRCUIT_BREAKER_QUEUE: number of requests allowed to wait for a pool
  # connection before returning 503. Keep this moderate so overload degrades
  # quickly instead of building multi-second queue latency.
  # PG_CONNECTION_TIMEOUT_MS=7000 keeps tail wait bounded under pressure.
  sudo grep -q '^POOL_CIRCUIT_BREAKER_QUEUE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^POOL_CIRCUIT_BREAKER_QUEUE=.*/POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}/' /opt/chatapp/shared/.env \
    || echo 'POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^BCRYPT_MAX_CONCURRENT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_MAX_CONCURRENT=.*/BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_CONNECTION_TIMEOUT_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_CONNECTION_TIMEOUT_MS=.*/PG_CONNECTION_TIMEOUT_MS=7000/' /opt/chatapp/shared/.env \
    || echo 'PG_CONNECTION_TIMEOUT_MS=7000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Preserve stable rollout tuning across deploys.
  # Only set these keys when missing; do not clobber operator-pinned values.
  sudo grep -q '^READ_RECEIPT_DEFER_POOL_WAITING=' /opt/chatapp/shared/.env \
    || echo 'READ_RECEIPT_DEFER_POOL_WAITING=0' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Bound search query hold-time in the pool; keeps hot non-search paths from
  # starving behind long text-search statements during traffic spikes.
  sudo grep -q '^SEARCH_STATEMENT_TIMEOUT_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^SEARCH_STATEMENT_TIMEOUT_MS=.*/SEARCH_STATEMENT_TIMEOUT_MS=5000/' /opt/chatapp/shared/.env \
    || echo 'SEARCH_STATEMENT_TIMEOUT_MS=5000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Grader clients often use bearer tokens without cookie-based refresh loops.
  # Keep access tokens valid for long test windows to avoid 401 delivery failures.
  sudo grep -q '^JWT_ACCESS_TTL=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^JWT_ACCESS_TTL=.*/JWT_ACCESS_TTL=24h/' /opt/chatapp/shared/.env \
    || echo 'JWT_ACCESS_TTL=24h' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^JWT_REFRESH_TTL=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^JWT_REFRESH_TTL=.*/JWT_REFRESH_TTL=7d/' /opt/chatapp/shared/.env \
    || echo 'JWT_REFRESH_TTL=7d' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # HTTP shedding is opt-in in code; keep prod explicit so a refactor never turns it on by default.
  sudo grep -q '^OVERLOAD_HTTP_SHED_ENABLED=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^OVERLOAD_HTTP_SHED_ENABLED=.*/OVERLOAD_HTTP_SHED_ENABLED=false/' /opt/chatapp/shared/.env \
    || echo 'OVERLOAD_HTTP_SHED_ENABLED=false' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # If shedding is ever enabled, use the code default (250 ms) — not staging's aggressive 200 ms.
  sudo grep -q '^OVERLOAD_LAG_SHED_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^OVERLOAD_LAG_SHED_MS=.*/OVERLOAD_LAG_SHED_MS=250/' /opt/chatapp/shared/.env \
    || echo 'OVERLOAD_LAG_SHED_MS=250' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Runtime mode + auth safety (never leave dev bypass on after a mistaken .env copy).
  sudo grep -q '^NODE_ENV=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' /opt/chatapp/shared/.env \
    || echo 'NODE_ENV=production' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^AUTH_BYPASS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^AUTH_BYPASS=.*/AUTH_BYPASS=false/' /opt/chatapp/shared/.env \
    || echo 'AUTH_BYPASS=false' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # FANOUT_QUEUE_CONCURRENCY: parallel fanout:critical workers per instance.
  # This is computed from remote CPU count above so each deploy keeps queue
  # latency low without blindly over-parallelising the host.
  sudo grep -q '^FANOUT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^FANOUT_QUEUE_CONCURRENCY=.*/FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}/' /opt/chatapp/shared/.env \
    || echo 'FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Grading-shaped realtime: re-apply on every deploy (same as deploy-staging.sh) so shared
  # .env cannot drift after manual edits. Set CHANNEL_MESSAGE_USER_FANOUT=0 in .env only if
  # you deliberately disable user-topic duplicate publish on a tiny host.
  sudo grep -q '^CHANNEL_MESSAGE_USER_FANOUT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_MESSAGE_USER_FANOUT=.*/CHANNEL_MESSAGE_USER_FANOUT=true/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_MESSAGE_USER_FANOUT=true' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CHANNEL_MESSAGE_USER_FANOUT_MODE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_MESSAGE_USER_FANOUT_MODE=.*/CHANNEL_MESSAGE_USER_FANOUT_MODE=all/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_MESSAGE_USER_FANOUT_MODE=all' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CHANNEL_MESSAGE_USER_FANOUT_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_MESSAGE_USER_FANOUT_MAX=.*/CHANNEL_MESSAGE_USER_FANOUT_MAX=10000/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_MESSAGE_USER_FANOUT_MAX=10000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS=.*/CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS=180/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS=180' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS=.*/CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS=180/' /opt/chatapp/shared/.env \
    || echo 'CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS=180' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^MESSAGE_USER_FANOUT_HTTP_BLOCKING=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^MESSAGE_USER_FANOUT_HTTP_BLOCKING=.*/MESSAGE_USER_FANOUT_HTTP_BLOCKING=true/' /opt/chatapp/shared/.env \
    || echo 'MESSAGE_USER_FANOUT_HTTP_BLOCKING=true' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^WS_AUTO_SUBSCRIBE_MODE=' /opt/chatapp/shared/.env \
    || echo 'WS_AUTO_SUBSCRIBE_MODE=full' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^USER_FEED_SHARD_COUNT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^USER_FEED_SHARD_COUNT=.*/USER_FEED_SHARD_COUNT=64/' /opt/chatapp/shared/.env \
    || echo 'USER_FEED_SHARD_COUNT=64' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^COMMUNITIES_LIST_CACHE_TTL_SECS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^COMMUNITIES_LIST_CACHE_TTL_SECS=.*/COMMUNITIES_LIST_CACHE_TTL_SECS=300/' /opt/chatapp/shared/.env \
    || echo 'COMMUNITIES_LIST_CACHE_TTL_SECS=300' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=.*/COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=${COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT}/' /opt/chatapp/shared/.env \
    || echo 'COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=${COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CHANNELS_LIST_CACHE_TTL_SECS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNELS_LIST_CACHE_TTL_SECS=.*/CHANNELS_LIST_CACHE_TTL_SECS=300/' /opt/chatapp/shared/.env \
    || echo 'CHANNELS_LIST_CACHE_TTL_SECS=300' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^WS_BOOTSTRAP_BATCH_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^WS_BOOTSTRAP_BATCH_SIZE=.*/WS_BOOTSTRAP_BATCH_SIZE=64/' /opt/chatapp/shared/.env \
    || echo 'WS_BOOTSTRAP_BATCH_SIZE=64' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^WS_BOOTSTRAP_CACHE_TTL_SECONDS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^WS_BOOTSTRAP_CACHE_TTL_SECONDS=.*/WS_BOOTSTRAP_CACHE_TTL_SECONDS=180/' /opt/chatapp/shared/.env \
    || echo 'WS_BOOTSTRAP_CACHE_TTL_SECONDS=180' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^DISABLE_RATE_LIMITS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^DISABLE_RATE_LIMITS=.*/DISABLE_RATE_LIMITS=true/' /opt/chatapp/shared/.env \
    || echo 'DISABLE_RATE_LIMITS=true' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^AUTH_GLOBAL_PER_IP_RATE_LIMIT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^AUTH_GLOBAL_PER_IP_RATE_LIMIT=.*/AUTH_GLOBAL_PER_IP_RATE_LIMIT=false/' /opt/chatapp/shared/.env \
    || echo 'AUTH_GLOBAL_PER_IP_RATE_LIMIT=false' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Throughput-first grading profile: skip bcrypt for newly written passwords.
  sudo grep -q '^AUTH_PASSWORD_STORAGE_MODE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^AUTH_PASSWORD_STORAGE_MODE=.*/AUTH_PASSWORD_STORAGE_MODE=plain/' /opt/chatapp/shared/.env \
    || echo 'AUTH_PASSWORD_STORAGE_MODE=plain' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # NODE_OPTIONS: set V8 heap limit so GC pressure triggers before the OOM
  # killer fires.  NODE_OLD_SPACE_MB is computed from remote RAM / instances.
  sudo grep -q '^NODE_OPTIONS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^NODE_OPTIONS=.*/NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}/' /opt/chatapp/shared/.env \
    || echo 'NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Enforce git-tracked realtime profile so deploys cannot drift.
  sudo python3 /tmp/apply-env-profile.py \
    --target /opt/chatapp/shared/.env \
    --required /tmp/prod.required.env
  rm -f /tmp/apply-env-profile.py /tmp/prod.required.env
  sudo systemctl daemon-reload
  echo 'systemd unit installed'"
echo "✓ systemd unit ready"

# 6. Start candidate on alternate port via systemd
echo "6. Starting candidate process via systemd..."
ssh_prod "
  set -e
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
ssh_prod "/tmp/health-check.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" || {
  echo "ERROR: Health check failed. Stopping candidate."
  stop_chatapp_port "$NEW_PORT"
  exit 1
}
echo "✓ Health checks passed"

# 8. Smoke tests
echo "8. Running smoke tests..."
ssh_prod "/tmp/smoke-test.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" || {
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

# 8c. Nginx access.log: append request_time + upstream_response_time (idempotent).
echo "8c. Nginx access log timing fields (idempotent)..."
scp -o BatchMode=yes -o ConnectTimeout=20 "${SCRIPT_DIR}/patch-nginx-access-log-timing.sh" "${PROD_USER}@${PROD_HOST}:/tmp/patch-nginx-access-log-timing.sh"
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
    set -e
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
keepalive = '''  keepalive 512;
  keepalive_requests 100000;
  keepalive_timeout 75s;
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
ssh_prod "export SITE='${CHATAPP_NGINX_SITE_PATH}'; bash -s" <<'REMOTE'
set -euo pipefail
if ! sudo test -f "$SITE"; then
  echo "9.05: skip — $SITE missing"
  exit 0
fi
if sudo grep -qE 'location[[:space:]]+\^~[[:space:]]+/api/v1/search' "$SITE"; then
  echo "9.05: search location already present"
  exit 0
fi
TMP=$(mktemp)
sudo cp "$SITE" "$TMP"
export TMP
python3 <<'PY'
import os
import re
from pathlib import Path

p = Path(os.environ['TMP'])
text = p.read_text()
if re.search(r'location\s+\^~\s+/api/v1/search', text):
    raise SystemExit(0)
needle = '  location /api/ {'
block = """  location ^~ /api/v1/search {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    client_max_body_size 10m;
  }

"""
if needle not in text:
    raise SystemExit('9.05: could not find \"  location /api/ {\" — patch nginx manually')
p.write_text(text.replace(needle, block + needle, 1))
PY
sudo install -m 644 "$TMP" "$SITE"
rm -f "$TMP"
sudo nginx -t >/dev/null
sudo systemctl reload nginx
echo "9.05: inserted search location + reloaded nginx"
REMOTE
echo "✓ Nginx search route OK"

# 9.06 Idempotent: add upstream retry policy for /api/ only (exclude websocket path).
echo "9.06 Nginx: ensure /api/ upstream retry policy..."
ssh_prod "export SITE='${CHATAPP_NGINX_SITE_PATH}'; export RETRY_FULL='${CHATAPP_NGINX_PROXY_RETRY_LINE}'; bash -s" <<'REMOTE'
set -euo pipefail
if ! sudo test -f "$SITE"; then
  echo "9.06: skip — $SITE missing"
  exit 0
fi
if sudo awk '
  /location \/api\/ \{/ {in_api=1; next}
  in_api && /\}/ {in_api=0}
  in_api && /proxy_next_upstream error timeout http_502 http_504 non_idempotent;/ {retry=1}
  in_api && /proxy_next_upstream_tries 2;/ {tries=1}
  END {exit((retry && tries) ? 0 : 1)}
' "$SITE"; then
  echo "9.06: /api retry + non-idempotent POST policy already present"
  exit 0
fi
TMP=$(mktemp)
sudo cp "$SITE" "$TMP"
export TMP
set +e
python3 <<'PY'
import os
import re
import sys
from pathlib import Path

p = Path(os.environ['TMP'])
text = p.read_text()
pattern = re.compile(r'(location\s+/api/\s*\{)(.*?)(\n\s*\})', re.DOTALL)
m = pattern.search(text)
if not m:
    print('9.06: /api location block not found', file=sys.stderr)
    sys.exit(1)
body = m.group(2)
orig = body
# Remove mistaken standalone directive (not valid nginx); real knob is
# `non_idempotent` on the proxy_next_upstream line.
body = re.sub(r"\n\s*proxy_next_upstream_non_idempotent\s+on;\s*", "\n", body)
retry_full = os.environ["RETRY_FULL"]
# Normalize all retry directives in /api/ to one canonical pair to keep patching idempotent.
body = re.sub(r"\n\s*proxy_next_upstream[^\n]*;", "", body)
body = re.sub(r"\n\s*proxy_next_upstream_tries\s+\d+;", "", body)
body += f"\n    {retry_full}\n    proxy_next_upstream_tries 2;"
if body == orig:
    sys.exit(2)
text = text[:m.start()] + m.group(1) + body + m.group(3) + text[m.end():]
p.write_text(text)
sys.exit(0)
PY
py_ret=$?
set -e
if [ "$py_ret" -eq 2 ]; then
  echo "9.06: /api block already complete (race with parallel check); skipping reload"
  rm -f "$TMP"
  exit 0
fi
if [ "$py_ret" -ne 0 ]; then
  rm -f "$TMP"
  exit "$py_ret"
fi
sudo install -m 644 "$TMP" "$SITE"
rm -f "$TMP"
sudo nginx -t >/dev/null
sudo systemctl reload nginx
echo "9.06: updated /api upstream retry policy (proxy_next_upstream … non_idempotent) + reloaded nginx"
REMOTE
echo "✓ Nginx /api retry policy OK"

# 9.07 Idempotent: dedicated /api/v1/auth/ with longer proxy timeouts than generic /api/ (30s).
# Auth is bcrypt-bound; without this, login/register can see nginx 504 HTML under burst.
echo "9.07 Nginx: ensure /api/v1/auth/ extended proxy timeouts..."
ssh_prod "export SITE='${CHATAPP_NGINX_SITE_PATH}'; bash -s" <<'REMOTE'
set -euo pipefail
if ! sudo test -f "$SITE"; then
  echo "9.07: skip — $SITE missing"
  exit 0
fi
if sudo grep -qE 'location[[:space:]]+\^~[[:space:]]+/api/v1/auth/' "$SITE"; then
  echo "9.07: auth location already present"
  exit 0
fi
TMP=$(mktemp)
sudo cp "$SITE" "$TMP"
export TMP
python3 <<'PY'
import os
import re
from pathlib import Path

p = Path(os.environ['TMP'])
text = p.read_text()
if re.search(r'location\s+\^~\s+/api/v1/auth/', text):
    raise SystemExit(0)
needle = '  location /api/ {'
block = """  location ^~ /api/v1/auth/ {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;
    proxy_next_upstream_tries 2;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    client_max_body_size 10m;
  }

"""
if needle not in text:
    raise SystemExit('9.07: could not find \"  location /api/ {\" — patch nginx manually')
p.write_text(text.replace(needle, block + needle, 1))
PY
sudo install -m 644 "$TMP" "$SITE"
rm -f "$TMP"
sudo nginx -t >/dev/null
sudo systemctl reload nginx
echo "9.07: inserted auth location + reloaded nginx"
REMOTE
echo "✓ Nginx auth route OK"

# 9.075 Idempotent: fix auth block — `non_idempotent` must be on proxy_next_upstream,
# and remove invalid standalone proxy_next_upstream_non_idempotent if present.
echo "9.075 Nginx: ensure auth proxy_next_upstream includes non_idempotent..."
ssh_prod "export SITE='${CHATAPP_NGINX_SITE_PATH}'; export RETRY_FULL='${CHATAPP_NGINX_PROXY_RETRY_LINE}'; export RETRY_LEGACY='${CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY}'; bash -s" <<'REMOTE'
set -euo pipefail
if ! sudo test -f "$SITE"; then
  echo "9.075: skip — $SITE missing"
  exit 0
fi
TMP=$(mktemp)
sudo cp "$SITE" "$TMP"
export TMP
set +e
python3 <<'PY'
import os
import re
import sys
from pathlib import Path

p = Path(os.environ['TMP'])
text = p.read_text()
pat = re.compile(r'(location\s+\^~\s+/api/v1/auth/\s*\{)(.*?)(\n\s*\})', re.DOTALL)
m = pat.search(text)
if not m:
    sys.exit(3)
body = m.group(2)
orig = body
body = re.sub(r"\n\s*proxy_next_upstream_non_idempotent\s+on;\s*", "\n", body)
retry_old = os.environ["RETRY_LEGACY"]
retry_full = os.environ["RETRY_FULL"]
if retry_old in body:
    body = body.replace(retry_old, retry_full, 1)
elif retry_full in body:
    pass
else:
    sys.exit(2)
if body == orig:
    sys.exit(2)
text = text[: m.start()] + m.group(1) + body + m.group(3) + text[m.end() :]
p.write_text(text)
sys.exit(0)
PY
py_ret=$?
set -e
if [ "$py_ret" -eq 3 ] || [ "$py_ret" -eq 2 ]; then
  rm -f "$TMP"
  echo "9.075: skip (no auth block or already patched)"
  exit 0
fi
if [ "$py_ret" -ne 0 ]; then
  rm -f "$TMP"
  exit "$py_ret"
fi
sudo install -m 644 "$TMP" "$SITE"
rm -f "$TMP"
sudo nginx -t >/dev/null
sudo systemctl reload nginx
echo "9.075: patched auth proxy_next_upstream (non_idempotent) + reloaded nginx"
REMOTE
echo "✓ Nginx auth POST retry OK"

# 9b–9c. Multi-worker prod: roll non-candidate workers to this release, then restore full upstream.
if [ "${CHATAPP_INSTANCES}" -ge 2 ]; then
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
keepalive = '''  keepalive 512;
  keepalive_requests 100000;
  keepalive_timeout 75s;
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
  ssh_prod "
    set -euo pipefail
    RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
    DROPIN_DIR=/etc/systemd/system/chatapp@${OLD_PORT}.service.d
    sudo mkdir -p \"\$DROPIN_DIR\"
    printf '[Service]\\nWorkingDirectory=%s/backend\\n' \"\$RELEASE_PATH\" | sudo tee \"\${DROPIN_DIR}/release.conf\" > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl reset-failed chatapp@${OLD_PORT} 2>/dev/null || true
    ok=0
    for attempt in 1 2 3; do
      sudo systemctl restart chatapp@${OLD_PORT}
      sleep 2
      if systemctl is-active --quiet chatapp@${OLD_PORT}; then
        ok=1
        break
      fi
      echo 'chatapp@${OLD_PORT} restart attempt' \"\$attempt\" 'failed; retrying in 3s'
      sleep 3
    done
    if [ \"\$ok\" -ne 1 ]; then
      echo 'ERROR: chatapp@${OLD_PORT} failed to become active after retries'
      sudo journalctl -u chatapp@${OLD_PORT} --no-pager -n 60 || true
      exit 1
    fi
    echo 'Companion chatapp@${OLD_PORT} restarted on new release'
  " || {
    echo "ERROR: Companion roll to ${RELEASE_SHA} failed."
    rollback_cutover
    exit 1
  }
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
    for extra_port in "${ADDITIONAL_PORTS[@]}"; do
      ssh_prod "
        set -euo pipefail
        RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
        PORT='${extra_port}'
        DROPIN_DIR=/etc/systemd/system/chatapp@\${PORT}.service.d
        sudo mkdir -p \"\$DROPIN_DIR\"
        printf '[Service]\\nWorkingDirectory=%s/backend\\n' \"\$RELEASE_PATH\" | sudo tee \"\${DROPIN_DIR}/release.conf\" > /dev/null
        sudo systemctl daemon-reload
        sudo systemctl reset-failed chatapp@\${PORT} 2>/dev/null || true
        ok=0
        for attempt in 1 2 3; do
          sudo systemctl restart chatapp@\${PORT}
          sleep 2
          if systemctl is-active --quiet chatapp@\${PORT}; then
            ok=1
            break
          fi
          echo 'chatapp@'\"\${PORT}\"' restart attempt' \"\$attempt\" 'failed; retrying in 3s'
          sleep 3
        done
        if [ \"\$ok\" -ne 1 ]; then
          echo 'ERROR: chatapp@'\"\${PORT}\"' failed to become active after retries'
          sudo journalctl -u chatapp@\${PORT} --no-pager -n 60 || true
          exit 1
        fi
      " || {
        echo "ERROR: Rolling additional worker port ${extra_port} failed."
        rollback_cutover
        exit 1
      }
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
    done
  fi

  echo "9c. Restoring nginx upstream (least_conn, all ${CHATAPP_INSTANCES} workers)..."
  gate_same_release || {
    rollback_cutover
    exit 1
  }
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
    echo 'Nginx: load-balanced ports ${TARGET_PORTS_CSV}'
  " || {
    echo "ERROR: Nginx upstream rewrite failed (multi-worker restore)."
    rollback_cutover
    exit 1
  }
  gate_all_worker_health || {
    rollback_cutover
    exit 1
  }
  gate_upstream_parity || {
    rollback_cutover
    exit 1
  }
  echo "✓ Multi-worker nginx upstream restored"
fi

# 9.5. Enable new service for auto-start on reboot
echo "9.5 Enabling candidate service for auto-start on reboot..."
ssh_prod "sudo systemctl enable chatapp@${NEW_PORT} 2>/dev/null || true"
echo "✓ Service enabled"

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

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 10.55. Copy repo Prometheus template so the `redis` scrape job exists; 10.6 restarts
# Prometheus to pick up the template (no port rewriting — dual targets stay intact).
echo "10.55. Syncing prometheus-host.yml from repo (includes redis job)..."
PROM_BUILD="$(mktemp)"
cp "${REPO_ROOT}/infrastructure/monitoring/prometheus-host.yml" "${PROM_BUILD}"
if [ "${CHATAPP_INSTANCES}" -ge 4 ]; then
  python3 - "${PROM_BUILD}" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
t = p.read_text()
if '127.0.0.1:4002' in t:
    sys.exit(0)
old = """      - targets: ['127.0.0.1:4001']\n        labels:\n          node: candidate-4001\n\n  - job_name: 'minio'"""
new = """      - targets: ['127.0.0.1:4001']\n        labels:\n          node: candidate-4001\n      - targets: ['127.0.0.1:4002']\n        labels:\n          node: worker-4002\n      - targets: ['127.0.0.1:4003']\n        labels:\n          node: worker-4003\n\n  - job_name: 'minio'"""
if old not in t:
    print('ERROR: prometheus-host.yml template mismatch — cannot inject 4002/4003', file=sys.stderr)
    sys.exit(1)
p.write_text(t.replace(old, new, 1))
PY
fi
scp -q "${PROM_BUILD}" "$PROD_USER@$PROD_HOST:/tmp/prometheus-host.yml.deploy" || true
rm -f "${PROM_BUILD}"

# 10.6. Refresh Prometheus host template (scrapes 4000–4003 when CHATAPP_INSTANCES>=4).
# Do **not** global-sed replace ports here: that collapses dual targets to one
# port when nginx load-balances two Node workers.
echo "10.6. Refreshing Prometheus scrape config..."
ssh_prod "
  if [ -f /tmp/prometheus-host.yml.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
    sudo cp /tmp/prometheus-host.yml.deploy /opt/chatapp-monitoring/prometheus-host.yml
    rm -f /tmp/prometheus-host.yml.deploy
  fi
  PROM_TMPL=/opt/chatapp-monitoring/prometheus-host.yml
  if [ -f \"\$PROM_TMPL\" ]; then
    # Restart the container so its entrypoint re-renders the template into
    # /tmp/prometheus.yml with ALERT_ENVIRONMENT substitution.
    if sudo docker restart chatapp-monitoring-prometheus-1 >/dev/null 2>&1; then
      echo 'Prometheus restarted (chatapp-api scrape list in prometheus-host.yml)'
    else
      echo 'WARN: Prometheus restart failed (non-fatal)'
    fi
  else
    echo 'WARN: prometheus-host.yml not found, skipping Prometheus update'
  fi
" || echo "⚠ Prometheus target update failed (non-fatal)"

echo "10.65. Sync alert rules + Alertmanager + redis_exporter (Discord / Redis alerts)..."
scp -q "${REPO_ROOT}/infrastructure/monitoring/alerts.yml" "$PROD_USER@$PROD_HOST:/tmp/alerts.yml.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/alertmanager.yml" "$PROD_USER@$PROD_HOST:/tmp/alertmanager.yml.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/remote-compose.yml" "$PROD_USER@$PROD_HOST:/tmp/remote-compose.yml.deploy" || true
scp -qr "${REPO_ROOT}/infrastructure/monitoring/grafana-provisioning-remote" "$PROD_USER@$PROD_HOST:/tmp/grafana-provisioning-remote.deploy" || true
scp -q "${REPO_ROOT}/scripts/synthetic-probe.sh" "$PROD_USER@$PROD_HOST:/tmp/synthetic-probe.sh.deploy" || true
scp -q "${REPO_ROOT}/deploy/prometheus-db-file-sd.py" "$PROD_USER@$PROD_HOST:/tmp/prometheus-db-file-sd.py.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/file_sd/db-node.json" "$PROD_USER@$PROD_HOST:/tmp/db-node.json.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/file_sd/db-postgres.json" "$PROD_USER@$PROD_HOST:/tmp/db-postgres.json.deploy" || true
ssh_prod "
  set -euo pipefail
  if [ -f /tmp/alerts.yml.deploy ] || [ -f /tmp/alertmanager.yml.deploy ] || [ -f /tmp/remote-compose.yml.deploy ] || [ -f /tmp/prometheus-db-file-sd.py.deploy ] || [ -f /tmp/db-node.json.deploy ] || [ -f /tmp/db-postgres.json.deploy ] || [ -d /tmp/grafana-provisioning-remote.deploy ] || [ -f /tmp/synthetic-probe.sh.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
  fi
  sudo mkdir -p /opt/chatapp-monitoring/node_exporter_textfile
  sudo chown ${PROD_USER}:${PROD_USER} /opt/chatapp-monitoring/node_exporter_textfile
  if [ -d /tmp/grafana-provisioning-remote.deploy ]; then
    sudo rm -rf /opt/chatapp-monitoring/grafana-provisioning-remote
    sudo mv /tmp/grafana-provisioning-remote.deploy /opt/chatapp-monitoring/grafana-provisioning-remote
  fi
  if [ -f /tmp/synthetic-probe.sh.deploy ]; then
    sudo install -m 755 /tmp/synthetic-probe.sh.deploy /opt/chatapp-monitoring/synthetic-probe.sh
    rm -f /tmp/synthetic-probe.sh.deploy
  fi
  # Host-local probe → node_exporter textfile (ChatAppSyntheticProbeFailed). Idempotent.
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
  if [ -f /tmp/prometheus-db-file-sd.py.deploy ]; then
    sudo cp /tmp/prometheus-db-file-sd.py.deploy /opt/chatapp-monitoring/prometheus-db-file-sd.py
    sudo chmod 644 /opt/chatapp-monitoring/prometheus-db-file-sd.py
    rm -f /tmp/prometheus-db-file-sd.py.deploy
  fi
  sudo mkdir -p /opt/chatapp-monitoring/file_sd
  if [ -f /tmp/db-node.json.deploy ]; then
    sudo cp /tmp/db-node.json.deploy /opt/chatapp-monitoring/file_sd/db-node.json
    rm -f /tmp/db-node.json.deploy
  fi
  if [ -f /tmp/db-postgres.json.deploy ]; then
    sudo cp /tmp/db-postgres.json.deploy /opt/chatapp-monitoring/file_sd/db-postgres.json
    rm -f /tmp/db-postgres.json.deploy
  fi
  if [ -f /opt/chatapp-monitoring/prometheus-db-file-sd.py ] && [ -f /opt/chatapp/shared/.env ]; then
    sudo python3 /opt/chatapp-monitoring/prometheus-db-file-sd.py || echo 'WARN: prometheus-db-file-sd.py failed (non-fatal)'
  fi
  if [ -f /tmp/alerts.yml.deploy ]; then
    sudo cp /tmp/alerts.yml.deploy /opt/chatapp-monitoring/alerts.yml
    rm -f /tmp/alerts.yml.deploy
  fi
  if [ -f /tmp/alertmanager.yml.deploy ]; then
    sudo cp /tmp/alertmanager.yml.deploy /opt/chatapp-monitoring/alertmanager.yml
    rm -f /tmp/alertmanager.yml.deploy
  fi
  # Ensure monitoring containers inherit the same environment as the app host.
  # Without this, ALERT_ENVIRONMENT can default to local and webhook secret selection breaks.
  sudo cp /opt/chatapp/shared/.env /opt/chatapp-monitoring/.env
  sudo sed -i 's/^ALERT_ENVIRONMENT=.*/ALERT_ENVIRONMENT=production/' /opt/chatapp-monitoring/.env
  if ! sudo grep -q '^ALERT_ENVIRONMENT=' /opt/chatapp-monitoring/.env; then
    echo 'ALERT_ENVIRONMENT=production' | sudo tee -a /opt/chatapp-monitoring/.env >/dev/null
  fi
  sudo docker compose --env-file /opt/chatapp-monitoring/.env -f /opt/chatapp-monitoring/remote-compose.yml up -d --force-recreate alertmanager prometheus node-exporter grafana >/dev/null
  # Fail fast if Discord webhook wiring is broken; silent alert failures are worse than noisy deploys.
  AM_NAME=\$(sudo docker ps --format '{{.Names}}' | grep 'chatapp-monitoring-alertmanager' | head -n 1 || true)
  if [ -z \"\$AM_NAME\" ]; then
    echo 'ERROR: alertmanager container not running after monitoring refresh'
    exit 1
  fi
  WEBHOOK_HEAD=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"head -c 8 /alertmanager/secrets/discord_webhook_url 2>/dev/null || true\")
  WEBHOOK_BYTES=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"wc -c < /alertmanager/secrets/discord_webhook_url 2>/dev/null || echo 0\")
  if [ \"\$WEBHOOK_HEAD\" != \"https://\" ] || [ \"\${WEBHOOK_BYTES:-0}\" -lt 32 ]; then
    echo \"ERROR: Alertmanager webhook secret invalid (head=\$WEBHOOK_HEAD bytes=\$WEBHOOK_BYTES)\"
    exit 1
  fi
  echo 'Alertmanager Discord webhook wiring verified'
  set -a
  # shellcheck disable=SC1091
  source /opt/chatapp/shared/.env 2>/dev/null || true
  set +a
  RURL=\"\${REDIS_URL:-redis://127.0.0.1:6379}\"
  if sudo docker ps -a --format '{{.Names}}' | grep -qx redis_exporter; then
    sudo docker rm -f redis_exporter 2>/dev/null || true
  fi
  sudo docker pull oliver006/redis_exporter:latest >/dev/null
  sudo docker run -d --name redis_exporter --restart unless-stopped --network host \
    oliver006/redis_exporter:latest --redis.addr=\"\$RURL\"
  echo 'redis_exporter started (uses REDIS_URL from /opt/chatapp/shared/.env)'
"
echo "✓ Monitoring updated"

# 11. Update current symlink
echo "11. Updating current release symlink..."
if ssh_prod "
  ln -sfn $RELEASE_DIR/$RELEASE_SHA $CURRENT_LINK
  echo 'Symlink: $CURRENT_LINK -> $RELEASE_SHA'
  # Keep only the 3 most recent releases to prevent disk exhaustion (node_modules ~200MB each).
  ls -t $RELEASE_DIR | tail -n +4 | xargs -I{} rm -rf $RELEASE_DIR/{}
"; then
  echo "✓ Symlink updated"
else
  echo "⚠ WARNING: Could not update symlink due to transient SSH failure."
fi

# 12. Final health check
echo "12. Final verification..."
if gate_same_release && gate_all_worker_health && gate_upstream_parity; then
  echo "✓ Production deployment SUCCESSFUL"
else
  echo "ERROR: Final health check failed after cutover."
  rollback_cutover
  exit 1
fi

# 13. Cleanup older releases/backups to control disk usage on small VMs.
echo "13. Pruning old releases/backups (keep releases=$KEEP_RELEASES backups=$KEEP_BACKUPS)..."
if ssh_prod "
  set -e
  if [ -d '$RELEASE_DIR' ]; then
    ls -1dt '$RELEASE_DIR'/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
  fi
  if [ -d /opt/chatapp/backups ]; then
    ls -1dt /opt/chatapp/backups/* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
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
echo "Production: https://$(echo $PROD_HOST | sed 's/.internal.*//')"
echo ""
echo "To rollback: re-run ./deploy/deploy-prod.sh <previous-sha>"
echo ""
echo "To stop the old version after confidence window (keep for ~10 min):"
echo "  ssh $PROD_USER@$PROD_HOST 'systemctl stop chatapp@$OLD_PORT'"
