#!/bin/bash
# deploy/deploy-staging.sh
# Deploy CI-built artifact to staging using candidate-port cutover.
# Usage: ./deploy/deploy-staging.sh <release-sha>

set -euo pipefail

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy/deploy-staging.sh <sha>}
STAGING_HOST="${STAGING_HOST:-136.114.103.71}"
STAGING_USER="${STAGING_USER:-$USER}"
GITHUB_REPO="${GITHUB_REPO:-CSE356-ChatApp-Group/CSE356-Discord}"
LOCAL_ARTIFACT_PATH="${LOCAL_ARTIFACT_PATH:-}"
RELEASE_DIR="/opt/chatapp/releases"
CURRENT_LINK="/opt/chatapp/current"
CANDIDATE_PORT=4001
LIVE_PORT=4000
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUTOVER_COMPLETED=0
NGINX_WORKER_CONNECTIONS="${NGINX_WORKER_CONNECTIONS:-16384}"

# Remote VM shape (used for Postgres / PgBouncer — independent of HTTP worker count).
_REMOTE_NPROC=$(ssh "${STAGING_USER}@${STAGING_HOST}" 'nproc --all' 2>/dev/null || echo 2)

# HTTP workers: staging nginx + systemd only ever load-balance **two** fixed ports
# (4000 + 4001).  Do **not** use nproc as CHATAPP_INSTANCES — that made pool math
# assume 3–4 Node processes while only 2 were running, starving each worker.
# Override CHATAPP_INSTANCES=1 for single-worker staging if desired.
if [[ -z "${CHATAPP_INSTANCES+x}" ]]; then
  CHATAPP_INSTANCES=$(python3 -c "n=int('${_REMOTE_NPROC}'); print(2 if n >= 2 else 1)")
fi

# PgBouncer **real** backends: scale with VM vCPUs so larger instances get more
# throughput without hand-editing .env.  Cap keeps shared_buffers / RAM sane.
# Typical virtual→real multiplexing ~2–3:1 from Node pools in transaction mode.
_PGB_SIZE=$(python3 -c "
ncpu = int('${_REMOTE_NPROC}')
inst = int('${CHATAPP_INSTANCES}')
cpu_part = ncpu * 50
extra = max(0, inst - 1) * 30
x = max(60, min(320, cpu_part + extra))
print(x)
")

# Per-Node pool max (virtual connections to PgBouncer): ~2.5:1 vs real backends.
PG_POOL_MAX_PER_INSTANCE=$(python3 -c "
p = int('${_PGB_SIZE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
ncpu = int('${_REMOTE_NPROC}')
pool_cap = min(180, 90 + ncpu * 10)
print(max(25, min(pool_cap, (p * 5) // (inst * 2))))
")

# Circuit queue + Postgres max_connections (deploy writes these — no manual vars).
POOL_CIRCUIT_BREAKER_QUEUE=$(python3 -c "
pmi = int('${PG_POOL_MAX_PER_INSTANCE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
print(max(64, min(900, pmi * 4 + inst * 80)))
")
PG_MAX_CONNECTIONS=$(python3 -c "
b = int('${_PGB_SIZE}')
print(max(120, min(450, b + 60)))
")

# Parallel fanout workers per instance — cheap headroom on larger CPUs.
FANOUT_QUEUE_CONCURRENCY=$(python3 -c "
n = int('${_REMOTE_NPROC}')
print(min(12, max(2, (n + 1) // 2 + 1)))
")

# bcrypt compare concurrency (staging uses lower BCRYPT_ROUNDS — still cap CPU).
BCRYPT_MAX_CONCURRENT=$(python3 -c "
n = int('${_REMOTE_NPROC}')
print(min(32, max(8, n * 4)))
")
# libuv thread pool per instance: minimum 8 threads to prevent bcrypt/dns starvation.
# With 2 instances on a 2-vCPU host: 8 threads/instance = 16 total.
# The previous formula (8/instances) gave only 4 threads with 2 instances,
# which caused DNS and fs I/O to queue behind burst bcrypt login ops.
UV_THREADPOOL_PER_INSTANCE=$(python3 -c "print(max(8, 16 // max(1, ${CHATAPP_INSTANCES})))")
# V8 max-old-space per instance: cap heap below the OOM killer threshold.
# Formula: min(1500, max(RAM_MB * 12%, 192))
#   - 12% of RAM scaled per instance (not a flat % so it works on small and large VMs)
#   - Floor of 192 MB (enough for startup overhead on any supported machine)
#   - Cap of 1500 MB (prevent single instance monopolising memory on large VMs)
# Examples:
#   2 GB / 1 inst: min(1500, max(246, 192)) = 246 MB   ← leaves room for PG + pgbouncer
#   2 GB / 2 inst: min(1500, max(123, 192)) = 192 MB   (floor kicks in)
#   7.8 GB / 2 inst: min(1500, max(468, 192)) = 468 MB ← reasonable on staging
_REMOTE_RAM_MB=$(ssh "${STAGING_USER}@${STAGING_HOST}" "awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo" 2>/dev/null || echo 7800)
NODE_OLD_SPACE_MB=$(python3 -c "print(min(1500, max(192, ${_REMOTE_RAM_MB} * 12 // 100 // ${CHATAPP_INSTANCES})))")

echo "=== Deploying ${RELEASE_SHA} to staging (${STAGING_USER}@${STAGING_HOST}) ==="
echo "  VM vCPUs: ${_REMOTE_NPROC}  HTTP workers: ${CHATAPP_INSTANCES}  pgbouncer_pool: ${_PGB_SIZE}  pg_max_conn: ${PG_MAX_CONNECTIONS}"
echo "  PG_POOL_MAX/instance: ${PG_POOL_MAX_PER_INSTANCE}  pool_circuit_queue: ${POOL_CIRCUIT_BREAKER_QUEUE}  fanout_conc: ${FANOUT_QUEUE_CONCURRENCY}"
"${SCRIPT_DIR}/preflight-check.sh" staging "$RELEASE_SHA" "$STAGING_USER" "$STAGING_HOST" "$GITHUB_REPO"

ssh "${STAGING_USER}@${STAGING_HOST}" "sudo logger -t chatapp-deploy \"event=start env=staging sha=${RELEASE_SHA} instances=${CHATAPP_INSTANCES}\"" || true

CURRENT_UPSTREAM_PORT=$(ssh "${STAGING_USER}@${STAGING_HOST}" "grep -oE '127\.0\.0\.1:[0-9]+' /etc/nginx/sites-available/chatapp | head -n1 | cut -d: -f2" || true)
if [[ -z "${CURRENT_UPSTREAM_PORT}" ]]; then
  CURRENT_UPSTREAM_PORT="${LIVE_PORT}"
fi

if [[ "${CURRENT_UPSTREAM_PORT}" == "4000" ]]; then
  LIVE_PORT=4000
  CANDIDATE_PORT=4001
elif [[ "${CURRENT_UPSTREAM_PORT}" == "4001" ]]; then
  LIVE_PORT=4001
  CANDIDATE_PORT=4000
else
  echo "ERROR: Unexpected upstream port '${CURRENT_UPSTREAM_PORT}' in nginx config."
  exit 1
fi

echo "Current live port: ${LIVE_PORT}"
echo "Candidate port: ${CANDIDATE_PORT}"

# Before step 0 rewrites nginx, detect whether the companion (CANDIDATE_PORT)
# was already running from a previous dual-instance deploy.  If it was, we
# re-add it to the upstream after the config write so we don't halve capacity
# for the duration of the deploy window (steps 0→7b.2 is ~5–10 minutes).
_COMPANION_WAS_ACTIVE=false
if [[ ${CHATAPP_INSTANCES} -ge 2 ]]; then
  if ssh "${STAGING_USER}@${STAGING_HOST}" \
       "systemctl is-active chatapp@${CANDIDATE_PORT}" >/dev/null 2>&1; then
    _COMPANION_WAS_ACTIVE=true
    echo "  (companion on port ${CANDIDATE_PORT} is active — will restore after nginx rewrite)"
  fi
fi

cleanup_candidate() {
  if [[ "${CUTOVER_COMPLETED}" == "1" ]]; then
    return 0
  fi

  echo "Deployment failed before cutover; cleaning up candidate port ${CANDIDATE_PORT}..."
  ssh "${STAGING_USER}@${STAGING_HOST}" "
    sudo systemctl stop chatapp@${CANDIDATE_PORT} 2>/dev/null || true
  " >/dev/null 2>&1 || true
}
trap cleanup_candidate ERR

echo "0) Ensuring Nginx serves frontend UI and proxies backend routes..."
# SCP the standalone nginx config (deploy/nginx/staging.conf → /tmp/chatapp-nginx.conf),
# then substitute __LIVE_PORT__ on the server and install it.  This keeps the
# config reviewable and diffable in version control instead of buried in a heredoc.
scp "${SCRIPT_DIR}/nginx/staging.conf" "${STAGING_USER}@${STAGING_HOST}:/tmp/chatapp-nginx.conf"
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  LIVE_PORT='${LIVE_PORT}'
  sed \"s/__LIVE_PORT__/\${LIVE_PORT}/g\" /tmp/chatapp-nginx.conf | sudo tee /etc/nginx/sites-available/chatapp >/dev/null
  sudo ln -sfn /etc/nginx/sites-available/chatapp /etc/nginx/sites-enabled/chatapp
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl reload nginx
  # Raise kernel TCP backlog so burst connection ramps don't drop SYN packets.
  sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
  sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
  # Raise nginx worker_connections and FD limit (Ubuntu defaults: 768 connections, 1024 nofile).
  sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' /etc/nginx/nginx.conf
  sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' /etc/nginx/nginx.conf
  # worker_rlimit_nofile lets nginx workers raise their own nofile limit (bypasses OS default 1024).
  sudo grep -q 'worker_rlimit_nofile' /etc/nginx/nginx.conf \
    || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' /etc/nginx/nginx.conf
  sudo nginx -t && sudo systemctl reload nginx
"

# Step 0 wrote nginx with only LIVE_PORT.  If the companion was running before
# the deploy started, restore it in the upstream immediately so capacity stays
# at 2 workers during the deploy window instead of dropping to 1.
# We use the same Python inline approach as step 7b.2.
if [[ "${_COMPANION_WAS_ACTIVE}" == "true" ]]; then
  echo "0c) Restoring companion port ${CANDIDATE_PORT} in nginx upstream (capacity preservation)..."
  ssh "${STAGING_USER}@${STAGING_HOST}" "
    set -euo pipefail
    sudo python3 - <<'PYEOF'
import re
cfg_path = '/etc/nginx/sites-available/chatapp'
config = open(cfg_path).read()
new_upstream = (
    'upstream chatapp_upstream {\n'
    '  least_conn;\n'
    '  server 127.0.0.1:${LIVE_PORT} max_fails=0;\n'
    '  server 127.0.0.1:${CANDIDATE_PORT} max_fails=0;\n'
    '  keepalive 256;\n'
    '  keepalive_requests 10000;\n'
    '  keepalive_timeout 75s;\n'
    '}'
)
config = re.sub(
    r'upstream chatapp_upstream \{[^}]+\}',
    new_upstream,
    config,
    flags=re.DOTALL,
)
open(cfg_path, 'w').write(config)
PYEOF
    sudo nginx -t && sudo systemctl reload nginx
    echo 'nginx upstream restored: ${LIVE_PORT} + ${CANDIDATE_PORT} (both active)'
  "
fi

echo "0a) Installing and configuring PgBouncer (transaction-mode connection pooler)..."
scp "${SCRIPT_DIR}/pgbouncer-setup.py" "${STAGING_USER}@${STAGING_HOST}:/tmp/pgbouncer-setup.py"
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  # Pass the pre-computed pool size so pgbouncer-setup.py uses exactly the
  # value derived from CHATAPP_INSTANCES, not the fallback nCPU*40 formula.
  # sudo strips exported env — pass pool size inline so VM-aware sizing applies.
  # Install PgBouncer if not already present on this host
  if ! dpkg -l pgbouncer 2>/dev/null | grep -q '^ii'; then
    sudo apt-get install -y pgbouncer
    echo 'PgBouncer installed.'
  fi
  sudo env PGBOUNCER_POOL_SIZE=${_PGB_SIZE} python3 /tmp/pgbouncer-setup.py
  sudo systemctl enable pgbouncer
  # pgbouncer is a sysv service on Ubuntu 22.04 — use the init.d script for
  # reliable stop/start (handles PID file cleanup correctly).  systemctl restart
  # fails when a process lives outside systemd's cgroup tracking.
  # 1. Stop cleanly via init.d (reads and cleans PID file)
  sudo service pgbouncer stop 2>/dev/null || true
  # 2. Kill any orphaned pgbouncer process by exact name (handles stale PID files)
  sudo pkill -x pgbouncer 2>/dev/null || true
  sleep 1
  # 3. Start fresh
  sudo service pgbouncer start
  sleep 1
  sudo systemctl is-active pgbouncer \
    || { echo 'ERROR: pgbouncer failed to start'; sudo journalctl -u pgbouncer --no-pager -n 30; exit 1; }
  echo 'PgBouncer running on 127.0.0.1:6432 in transaction-pooling mode.'
"

echo "0b) Tuning PostgreSQL for available RAM and CPU..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  # Auto-detect total RAM in MB
  TOTAL_RAM_MB=\$(awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo)
  NCPU=\$(nproc --all)

  # Formulas (standard pg_tune approach — idempotent SHOW+ALTER):
  #   shared_buffers      = 25% RAM
  #   effective_cache_size = 75% RAM  (planner hint, no allocation)
  #   work_mem            = derived from RAM / max_connections (capped)
  #   wal_buffers         = 64 MB
  #   max_connections     = PG_MAX_CONNECTIONS (from deploy host — scales with VM)
  #
  # Scaling: RAM/CPU/max_connections co-vary so larger VMs pick up capacity automatically.
  PG_MAX_CONNECTIONS='${PG_MAX_CONNECTIONS}'
  SHB_MB=\$(( TOTAL_RAM_MB * 25 / 100 ))
  ECF_MB=\$(( TOTAL_RAM_MB * 75 / 100 ))
  WRK_MB=\$(python3 -c \"import math; ram=\${TOTAL_RAM_MB}; mc=int('\${PG_MAX_CONNECTIONS}'); print(max(4, min(64, ram // max(mc * 4, 1))))\")

  echo \"RAM=\${TOTAL_RAM_MB}MB nCPU=\${NCPU} max_conn=\${PG_MAX_CONNECTIONS} → shared_buffers=\${SHB_MB}MB work_mem=\${WRK_MB}MB\"

  # Enable pg_stat_statements via ALTER SYSTEM (idempotent, no sed quoting risk).
  # ALTER SYSTEM writes to postgresql.auto.conf which takes precedence over
  # postgresql.conf, so the sed approach is not needed and was fragile against
  # the commented-out default form: #shared_preload_libraries = ''
  sudo -u postgres psql -qAt \
    -c \"ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';\" \
    2>&1 | grep -v 'change directory' || true
  echo \"pg_stat_statements set via ALTER SYSTEM\"

  sudo -u postgres psql -qAt \
    -c \"ALTER SYSTEM SET shared_buffers         = '\${SHB_MB}MB';\" \
    -c \"ALTER SYSTEM SET effective_cache_size   = '\${ECF_MB}MB';\" \
    -c \"ALTER SYSTEM SET work_mem               = '\${WRK_MB}MB';\" \
    -c \"ALTER SYSTEM SET wal_buffers            = '64MB';\" \
    -c \"ALTER SYSTEM SET max_connections        = \${PG_MAX_CONNECTIONS};\" \\
    -c \"ALTER SYSTEM SET checkpoint_completion_target = '0.9';\" \
    -c \"ALTER SYSTEM SET random_page_cost       = '1.1';\" \
    -c \"ALTER SYSTEM SET pg_stat_statements.track = 'all';\" \
    2>&1 | grep -v 'change directory' || true

  sudo -u postgres psql -qAt -c \"SELECT pg_reload_conf();\" > /dev/null || true
  PENDING=\$(sudo -u postgres psql -qAt -c \"SELECT EXISTS (SELECT 1 FROM pg_settings WHERE pending_restart)\")
  if [ \"\$PENDING\" = \"t\" ]; then
    echo 'PostgreSQL: pending_restart after ALTER SYSTEM — restarting postmaster once.'
    sudo systemctl restart postgresql
    sleep 3
  else
    echo 'PostgreSQL: no pending_restart — skipped full cluster restart (reload only).'
  fi
  sudo systemctl is-active postgresql \
    || { echo 'ERROR: PostgreSQL is not active after tuning'; exit 1; }
  sudo -u postgres psql chatapp_staging -qAt \
    -c \"CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\" \
    2>&1 | grep -v 'change directory' || true
  echo 'PostgreSQL tuning applied.'
"

if [[ -z "$LOCAL_ARTIFACT_PATH" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required for artifact download."
  exit 1
fi

ARTIFACT="chatapp-${RELEASE_SHA}.tar.gz"
DOWNLOADED_ARTIFACT="/tmp/${ARTIFACT}"
SOURCE_ARTIFACT="${LOCAL_ARTIFACT_PATH:-$DOWNLOADED_ARTIFACT}"

if [[ -n "$LOCAL_ARTIFACT_PATH" ]]; then
  echo "1) Using local CI artifact for ${RELEASE_SHA}..."
else
  echo "1) Downloading CI-built artifact for ${RELEASE_SHA}..."
  gh release download "release-${RELEASE_SHA}" -R "${GITHUB_REPO}" -p "${ARTIFACT}" -O "${DOWNLOADED_ARTIFACT}"
fi

echo "2) Copying artifact and verification scripts to staging host..."
scp "${SOURCE_ARTIFACT}" "${STAGING_USER}@${STAGING_HOST}:/tmp/${ARTIFACT}"
scp deploy/health-check.sh deploy/smoke-test.sh deploy/candidate-ws-smoke.cjs deploy/pgbouncer-setup.py "${STAGING_USER}@${STAGING_HOST}:/tmp/"
if [[ -z "$LOCAL_ARTIFACT_PATH" ]]; then
  rm -f "${DOWNLOADED_ARTIFACT}"
fi

echo "3) Installing/updating systemd unit on host..."
# Use ssh stdin pipe instead of scp: OpenSSH >=9.0 switches scp to the SFTP
# subsystem which misparses '@' in remote paths, causing "Permission denied".
ssh "${STAGING_USER}@${STAGING_HOST}" 'cat > /tmp/chatapp-template.service' < "${SCRIPT_DIR}/chatapp-template.service"
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  sed 's/__DEPLOY_USER__/${STAGING_USER}/g' /tmp/chatapp-template.service | sudo tee /etc/systemd/system/chatapp@.service > /dev/null
  # PORT must not be in shared .env — systemd provides it via Environment=PORT=%i
  sudo sed -i '/^PORT=/d' /opt/chatapp/shared/.env
  # Ensure performance-critical env vars are set for this deployment.
  # BCRYPT_ROUNDS=6: ~30ms/op on a 2-vCPU Xeon vs ~125ms at rounds=8.
  # Staging is CPU-bound under load; reducing from 8→6 cuts bcrypt CPU ~4×
  # (each extra round doubles cost) while remaining above OWASP minimum (4).
  sudo grep -q '^BCRYPT_ROUNDS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_ROUNDS=.*/BCRYPT_ROUNDS=6/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_ROUNDS=6' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # UV_THREADPOOL_SIZE: increase libuv thread pool for concurrent bcrypt/dns/fs work.
  sudo grep -q '^UV_THREADPOOL_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^UV_THREADPOOL_SIZE=.*/UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # PG_POOL_MAX: Node→PgBouncer virtual connections per instance (see
  # PG_POOL_MAX_PER_INSTANCE in deploy header). Totals scale with CHATAPP_INSTANCES
  # and PGBOUNCER_POOL_SIZE; the circuit breaker sheds before PgBouncer queues
  # unbounded work.
  sudo grep -q '^PG_POOL_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # POOL_CIRCUIT_BREAKER_QUEUE: scales with PG_POOL_MAX (see header formulas).
  sudo grep -q '^POOL_CIRCUIT_BREAKER_QUEUE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^POOL_CIRCUIT_BREAKER_QUEUE=.*/POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}/' /opt/chatapp/shared/.env \
    || echo 'POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^BCRYPT_MAX_CONCURRENT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_MAX_CONCURRENT=.*/BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_CONNECTION_TIMEOUT_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_CONNECTION_TIMEOUT_MS=.*/PG_CONNECTION_TIMEOUT_MS=10000/' /opt/chatapp/shared/.env \
    || echo 'PG_CONNECTION_TIMEOUT_MS=10000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Keep access tokens valid across long load windows to reduce auth churn-driven 401s.
  sudo grep -q '^JWT_ACCESS_TTL=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^JWT_ACCESS_TTL=.*/JWT_ACCESS_TTL=24h/' /opt/chatapp/shared/.env \
    || echo 'JWT_ACCESS_TTL=24h' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^JWT_REFRESH_TTL=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^JWT_REFRESH_TTL=.*/JWT_REFRESH_TTL=7d/' /opt/chatapp/shared/.env \
    || echo 'JWT_REFRESH_TTL=7d' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY: 1 per instance on staging — with
  # CHATAPP_INSTANCES>=2 that means up to 2 total indexing jobs in flight
  # across the cluster, which matches the 2-CPU budget without over-subscribing.
  sudo grep -q '^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=.*/SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1/' /opt/chatapp/shared/.env \
    || echo 'SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^FANOUT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^FANOUT_QUEUE_CONCURRENCY=.*/FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}/' /opt/chatapp/shared/.env \
    || echo 'FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # COMPAS-style throughput: duplicate channel message:created to user:<id> (default in app;
  # pin here so shared .env on long-lived staging VMs stays aligned after manual edits).
  sudo grep -q '^CHANNEL_MESSAGE_USER_FANOUT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_MESSAGE_USER_FANOUT=.*/CHANNEL_MESSAGE_USER_FANOUT=true/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_MESSAGE_USER_FANOUT=true' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^CHANNEL_MESSAGE_USER_FANOUT_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^CHANNEL_MESSAGE_USER_FANOUT_MAX=.*/CHANNEL_MESSAGE_USER_FANOUT_MAX=10000/' /opt/chatapp/shared/.env \
    || echo 'CHANNEL_MESSAGE_USER_FANOUT_MAX=10000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^WS_BOOTSTRAP_BATCH_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^WS_BOOTSTRAP_BATCH_SIZE=.*/WS_BOOTSTRAP_BATCH_SIZE=120/' /opt/chatapp/shared/.env \
    || echo 'WS_BOOTSTRAP_BATCH_SIZE=120' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # Fail fast with 503 when event-loop lag spikes (avoids long PG pool waits + status 0).
  sudo grep -q '^OVERLOAD_HTTP_SHED_ENABLED=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^OVERLOAD_HTTP_SHED_ENABLED=.*/OVERLOAD_HTTP_SHED_ENABLED=true/' /opt/chatapp/shared/.env \
    || echo 'OVERLOAD_HTTP_SHED_ENABLED=true' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^OVERLOAD_LAG_SHED_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^OVERLOAD_LAG_SHED_MS=.*/OVERLOAD_LAG_SHED_MS=200/' /opt/chatapp/shared/.env \
    || echo 'OVERLOAD_LAG_SHED_MS=200' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # NODE_OPTIONS: set V8 heap limit so GC pressure triggers before the OOM
  # killer interferes.  NODE_OLD_SPACE_MB is computed from remote RAM / instances.
  sudo grep -q '^NODE_OPTIONS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^NODE_OPTIONS=.*/NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}/' /opt/chatapp/shared/.env \
    || echo 'NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo systemctl daemon-reload
  echo 'systemd unit installed'
"

echo "4) Unpacking artifact into immutable release directory..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  RELEASE_PATH='${RELEASE_DIR}/${RELEASE_SHA}'
  mkdir -p '${RELEASE_DIR}'
  mkdir -p \"\${RELEASE_PATH}\"
  tar xzf '/tmp/${ARTIFACT}' -C \"\${RELEASE_PATH}\"

  # Install backend runtime deps only if node_modules are not bundled.
  if [ ! -d \"\${RELEASE_PATH}/backend/node_modules\" ]; then
    cd \"\${RELEASE_PATH}/backend\"
    npm ci --omit=dev
  fi

  # Ensure schema exists before API process boots.
  set -a
  source /opt/chatapp/shared/.env
  set +a
  node "\${RELEASE_PATH}/backend/dist/db/migrate.js"

  chmod +x /tmp/health-check.sh /tmp/smoke-test.sh
"

echo "5) Starting candidate app on port ${CANDIDATE_PORT} via systemd..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  RELEASE_PATH='${RELEASE_DIR}/${RELEASE_SHA}'

  # Write per-port drop-in so systemd uses this release's working directory.
  DROPIN_DIR=/etc/systemd/system/chatapp@${CANDIDATE_PORT}.service.d
  sudo mkdir -p \"\${DROPIN_DIR}\"
  printf '[Service]\nWorkingDirectory=%s/backend\n' \"\${RELEASE_PATH}\" | sudo tee \"\${DROPIN_DIR}/release.conf\" > /dev/null
  sudo systemctl daemon-reload

  # Stop any stale candidate, then start fresh.
  sudo systemctl stop chatapp@${CANDIDATE_PORT} 2>/dev/null || true
  sleep 1
  sudo systemctl start chatapp@${CANDIDATE_PORT}
  echo 'Candidate started via systemd (chatapp@${CANDIDATE_PORT})'
"

echo "6) Running health, smoke, and candidate WebSocket round-trip on candidate..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  /tmp/health-check.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
  /tmp/smoke-test.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
  RELEASE_PATH='${RELEASE_DIR}/${RELEASE_SHA}'
  export API_CONTRACT_BASE_URL=http://127.0.0.1:${CANDIDATE_PORT}/api/v1
  export API_CONTRACT_WS_URL=ws://127.0.0.1:${CANDIDATE_PORT}/ws
  # Run from release backend/ so require('ws') resolves (Node ignores NODE_PATH for /tmp entry reliably).
  cp /tmp/candidate-ws-smoke.cjs \"\${RELEASE_PATH}/backend/candidate-ws-smoke.cjs\"
  cd \"\${RELEASE_PATH}/backend\" && node ./candidate-ws-smoke.cjs
  rm -f \"\${RELEASE_PATH}/backend/candidate-ws-smoke.cjs\"
"

echo "7) Switching Nginx upstream from ${LIVE_PORT} to ${CANDIDATE_PORT}..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  sudo sed -i 's/127.0.0.1:${LIVE_PORT}/127.0.0.1:${CANDIDATE_PORT}/g' /etc/nginx/sites-available/chatapp
  sudo nginx -t
  sudo systemctl reload nginx
"
CUTOVER_COMPLETED=1

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
echo "7a) Prometheus + Alertmanager rules + Redis exporter (Discord capacity alerts need current rules)..."
scp -q "${REPO_ROOT}/infrastructure/monitoring/prometheus-host.yml" "${STAGING_USER}@${STAGING_HOST}:/tmp/prometheus-host.yml.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/alerts.yml" "${STAGING_USER}@${STAGING_HOST}:/tmp/alerts.yml.deploy" || true
scp -q "${REPO_ROOT}/infrastructure/monitoring/alertmanager.yml" "${STAGING_USER}@${STAGING_HOST}:/tmp/alertmanager.yml.deploy" || true
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  if [ -f /tmp/prometheus-host.yml.deploy ] || [ -f /tmp/alerts.yml.deploy ] || [ -f /tmp/alertmanager.yml.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
  fi
  if [ -f /tmp/prometheus-host.yml.deploy ]; then
    sudo cp /tmp/prometheus-host.yml.deploy /opt/chatapp-monitoring/prometheus-host.yml
    rm -f /tmp/prometheus-host.yml.deploy
  fi
  if [ -f /tmp/alerts.yml.deploy ]; then
    sudo cp /tmp/alerts.yml.deploy /opt/chatapp-monitoring/alerts.yml
    rm -f /tmp/alerts.yml.deploy
  fi
  if [ -f /tmp/alertmanager.yml.deploy ]; then
    sudo cp /tmp/alertmanager.yml.deploy /opt/chatapp-monitoring/alertmanager.yml
    rm -f /tmp/alertmanager.yml.deploy
  fi
  # Keep monitoring env in sync with shared host env so webhook selection uses staging.
  sudo cp /opt/chatapp/shared/.env /opt/chatapp-monitoring/.env
  sudo sed -i 's/^ALERT_ENVIRONMENT=.*/ALERT_ENVIRONMENT=staging/' /opt/chatapp-monitoring/.env
  if ! sudo grep -q '^ALERT_ENVIRONMENT=' /opt/chatapp-monitoring/.env; then
    echo 'ALERT_ENVIRONMENT=staging' | sudo tee -a /opt/chatapp-monitoring/.env >/dev/null
  fi
  sudo docker compose --env-file /opt/chatapp-monitoring/.env -f /opt/chatapp-monitoring/remote-compose.yml up -d --force-recreate alertmanager prometheus >/dev/null 2>&1 || true
  # Staging guardrail: warn loudly if Discord webhook wiring is invalid.
  AM_NAME=\$(sudo docker ps --format '{{.Names}}' | grep 'chatapp-monitoring-alertmanager' | head -n 1 || true)
  if [ -n \"\$AM_NAME\" ]; then
    WEBHOOK_HEAD=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"head -c 8 /alertmanager/secrets/discord_webhook_url 2>/dev/null || true\")
    WEBHOOK_BYTES=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"wc -c < /alertmanager/secrets/discord_webhook_url 2>/dev/null || echo 0\")
    if [ \"\$WEBHOOK_HEAD\" != \"https://\" ] || [ \"\${WEBHOOK_BYTES:-0}\" -lt 32 ]; then
      echo \"WARN: Alertmanager webhook secret looks invalid in staging (head=\$WEBHOOK_HEAD bytes=\$WEBHOOK_BYTES)\"
    else
      echo 'Alertmanager Discord webhook wiring verified (staging)'
    fi
  else
    echo 'WARN: alertmanager container not running after monitoring refresh'
  fi
  # redis_exporter on host network — scrapes 127.0.0.1:6379; Prometheus hits :9121
  if sudo docker ps -a --format '{{.Names}}' | grep -qx redis_exporter; then
    sudo docker rm -f redis_exporter 2>/dev/null || true
  fi
  sudo docker pull oliver006/redis_exporter:latest >/dev/null
  sudo docker run -d --name redis_exporter --restart unless-stopped --network host \
    oliver006/redis_exporter:latest --redis.addr=redis://127.0.0.1:6379
  echo 'redis_exporter started (host network, :9121/metrics)'
" || echo "Warning: Prometheus/redis_exporter step failed (non-critical)" >&2

# ── Step 7b: companion instance (dual-worker mode) ───────────────────────────
# When CHATAPP_INSTANCES>=2, the deploy was a blue-green cutover: nginx now
# points only to CANDIDATE_PORT.  We roll the companion (LIVE_PORT) to the same
# release while nginx has no traffic going to it, then add it back to the
# upstream so both workers share the load.
#
# Architecture note: all persistent state (connections, presence, cache) lives
# in Redis/PostgreSQL, so two Node.js instances are fully independent and
# correct.  PG pool budget is pre-divided by CHATAPP_INSTANCES above.
if [[ ${CHATAPP_INSTANCES} -ge 2 ]]; then
  echo "7b) Rolling companion instance on port ${LIVE_PORT} to new release (dual-worker mode)..."
  ssh "${STAGING_USER}@${STAGING_HOST}" "
    set -euo pipefail
    RELEASE_PATH='${RELEASE_DIR}/${RELEASE_SHA}'

    # Point the companion's systemd drop-in at the new release directory.
    DROPIN_DIR=/etc/systemd/system/chatapp@${LIVE_PORT}.service.d
    sudo mkdir -p \"\${DROPIN_DIR}\"
    printf '[Service]\nWorkingDirectory=%s/backend\n' \"\${RELEASE_PATH}\" \
      | sudo tee \"\${DROPIN_DIR}/release.conf\" > /dev/null
    sudo systemctl daemon-reload

    # Restart companion.  nginx has no traffic to this port right now so the
    # brief downtime is invisible to users.
    sudo systemctl stop chatapp@${LIVE_PORT} 2>/dev/null || true
    sleep 1
    sudo systemctl start chatapp@${LIVE_PORT}
    echo 'Companion started on port ${LIVE_PORT}'
  "

  echo "7b.1) Health-checking companion on port ${LIVE_PORT}..."
  ssh "${STAGING_USER}@${STAGING_HOST}" \
    "/tmp/health-check.sh ${LIVE_PORT} http://127.0.0.1:${LIVE_PORT}"

  echo "7b.2) Adding companion to nginx upstream (load-balancing both workers)..."
  ssh "${STAGING_USER}@${STAGING_HOST}" "
    set -euo pipefail
    # Rewrite the upstream block to include both ports. max_fails=0 disables
    # nginx's passive health check — the Node-level circuit breaker already
    # handles overload via fast 503s; if nginx also marks upstreams "down" on
    # 503s, both instances get marked unavailable simultaneously and nginx
    # returns 502 "no live upstreams" for every subsequent request (death spiral).
    sudo python3 - <<'PYEOF'
import re

cfg_path = '/etc/nginx/sites-available/chatapp'
config = open(cfg_path).read()
new_upstream = (
    'upstream chatapp_upstream {\n'
    '  least_conn;\n'
    '  server 127.0.0.1:${CANDIDATE_PORT} max_fails=0;\n'
    '  server 127.0.0.1:${LIVE_PORT} max_fails=0;\n'
    '  keepalive 256;\n'
    '  keepalive_requests 10000;\n'
    '  keepalive_timeout 75s;\n'
    '}'
)
config = re.sub(
    r'upstream chatapp_upstream \{[^}]+\}',
    new_upstream,
    config,
    flags=re.DOTALL,
)
open(cfg_path, 'w').write(config)
PYEOF
    sudo nginx -t
    sudo systemctl reload nginx
    echo 'nginx upstream now includes both ports ${CANDIDATE_PORT} and ${LIVE_PORT}'
  "

  echo "7b.3) Enabling companion service for auto-start on reboot..."
  ssh "${STAGING_USER}@${STAGING_HOST}" \
    "sudo systemctl enable chatapp@${LIVE_PORT} 2>/dev/null || true"
fi

echo "8) Enabling candidate service for auto-start on reboot..."
ssh "${STAGING_USER}@${STAGING_HOST}" "sudo systemctl enable chatapp@${CANDIDATE_PORT} 2>/dev/null || true"

echo "9) Updating current symlink to new release..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  ln -sfn '${RELEASE_DIR}/${RELEASE_SHA}' '${CURRENT_LINK}'
  # Keep only the 3 most recent releases to prevent disk exhaustion (node_modules ~200MB each).
  ls -t '${RELEASE_DIR}' | tail -n +4 | xargs -I{} rm -rf '${RELEASE_DIR}/{}'
"

echo "10) Post-cutover verification..."
ssh "${STAGING_USER}@${STAGING_HOST}" "/tmp/health-check.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}"

echo "11) Verifying frontend root from Nginx..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  curl -fsS http://127.0.0.1/ >/dev/null
"

trap - ERR

ssh "${STAGING_USER}@${STAGING_HOST}" "sudo logger -t chatapp-deploy \"event=complete env=staging sha=${RELEASE_SHA} candidate_port=${CANDIDATE_PORT} live_port=${LIVE_PORT}\"" || true

echo ""
echo "Staging deployment successful."
echo "- Candidate used port: ${CANDIDATE_PORT}"
echo "- Live traffic now points to: ${CANDIDATE_PORT}"
if [[ ${CHATAPP_INSTANCES} -ge 2 ]]; then
  echo "- Companion worker running on port: ${LIVE_PORT} (same release, load-balanced)"
  echo ""
  echo "Rollback (stop companion, point nginx at single old release):"
  echo "  1. ssh ${STAGING_USER}@${STAGING_HOST} 'sudo systemctl stop chatapp@${LIVE_PORT}'"
  echo "  2. ssh ${STAGING_USER}@${STAGING_HOST} 'sudo sed -i s/max_fails.*fail_timeout.*s;//g /etc/nginx/sites-available/chatapp && sudo sed -i /server.*${LIVE_PORT}/d /etc/nginx/sites-available/chatapp && sudo nginx -t && sudo systemctl reload nginx'"
  echo "  (or just re-deploy the previous SHA)"
else
  echo "- Previous version was kept for rollback"
  echo ""
  echo "Rollback (immediate — old release still running on port ${LIVE_PORT}):"
  echo "  ssh ${STAGING_USER}@${STAGING_HOST} 'sudo sed -i \"s/127.0.0.1:${CANDIDATE_PORT}/127.0.0.1:${LIVE_PORT}/g\" /etc/nginx/sites-available/chatapp && sudo nginx -t && sudo systemctl reload nginx'"
  echo ""
  echo "To stop the old version after confidence window:"
  echo "  ssh ${STAGING_USER}@${STAGING_HOST} 'sudo systemctl stop chatapp@${LIVE_PORT}'"
fi
echo "- Deployment used immutable release dir: ${RELEASE_DIR}/${RELEASE_SHA}"
