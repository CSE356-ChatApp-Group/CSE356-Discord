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

# Auto-detect CPU count on the target host and derive CHATAPP_INSTANCES.
# Clamped to [1, 4]: beyond 4 workers there is no measurable benefit on
# typical staging CPUs, and PG/Redis lock contention grows with workers.
if [[ -z "${CHATAPP_INSTANCES+x}" ]]; then
  _REMOTE_NPROC=$(ssh "${STAGING_USER}@${STAGING_HOST}" 'nproc --all' 2>/dev/null || echo 2)
  CHATAPP_INSTANCES=$(python3 -c "n=int('${_REMOTE_NPROC}'); print(min(max(n,1),4))")
fi
# PG connection sizing — maintain a 2.5:1 virtual→real ratio for all CPU counts.
#
# Formula (validated against load tests):
#   PGBOUNCER_POOL_SIZE = min(instances × 50, 120)  ← real PG backends, capped
#                                                     by max_connections=120 budget
#   PG_POOL_MAX_PER_INSTANCE = PGBOUNCER × 2.5 / instances  ← Node pool depth
#
# Results per CPU count:
#   1 CPU:  pgb=50,  pool/inst=125 → capped 100  :  50 real = 2.0:1
#   2 CPUs: pgb=100, pool/inst=100 → 200 virtual : 100 real = 2.0:1  (target)
#   3 CPUs: pgb=120, pool/inst=100 → 300 virtual : 120 real = 2.5:1
#   4 CPUs: pgb=120, pool/inst=75  → 300 virtual : 120 real = 2.5:1
#
# Fewer pool slots per instance = deeper Node-level checkout queue = slower p95.
# This formula keeps per-instance depth constant relative to real PG bandwidth.
# PgBouncer pool_size: min(instances×50, 120) real PG backends.
# Raised from ×40/cap90 → ×50/cap120 to reduce PgBouncer queue depth under burst.
# PG max_connections must be ≥ pool_size + 3 reserved; set to 120 to match.
_PGB_SIZE=$(python3 -c "print(min(${CHATAPP_INSTANCES} * 50, 120))")
PG_POOL_MAX_PER_INSTANCE=$(python3 -c "print(max(25, min(100, int(${_PGB_SIZE} * 5 // (${CHATAPP_INSTANCES} * 2)))))") # 2.5:1 = ×5÷(n×2)
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
"${SCRIPT_DIR}/preflight-check.sh" staging "$RELEASE_SHA" "$STAGING_USER" "$STAGING_HOST" "$GITHUB_REPO"

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
  sudo sysctl -w net.ipv4.tcp_max_syn_backlog=4096 >/dev/null
  sudo sysctl -w net.core.somaxconn=4096 >/dev/null
  # Raise nginx worker_connections and FD limit (Ubuntu defaults: 768 connections, 1024 nofile).
  sudo sed -i 's/worker_connections [0-9]*/worker_connections 4096/' /etc/nginx/nginx.conf
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
  export PGBOUNCER_POOL_SIZE=${_PGB_SIZE}
  # Install PgBouncer if not already present on this host
  if ! dpkg -l pgbouncer 2>/dev/null | grep -q '^ii'; then
    sudo apt-get install -y pgbouncer
    echo 'PgBouncer installed.'
  fi
  sudo python3 /tmp/pgbouncer-setup.py
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
  #   work_mem            = RAM / max_connections / 3 (capped 16-64 MB)
  #   wal_buffers         = 64 MB
  #   max_connections     = 120   (headroom for pool_size=100 + 3 superuser reserved)
  #
  # Scaling: all values are derived from detected RAM/CPU so they auto-adjust
  # when this script runs on a larger VM (4-CPU, 16 GB, etc.)
  SHB_MB=\$(( TOTAL_RAM_MB * 25 / 100 ))
  ECF_MB=\$(( TOTAL_RAM_MB * 75 / 100 ))
  WRK_MB=\$(python3 -c \"m=max(16, min(64, \${TOTAL_RAM_MB} // 300)); print(m)\")

  echo \"RAM=\${TOTAL_RAM_MB}MB nCPU=\${NCPU} → shared_buffers=\${SHB_MB}MB work_mem=\${WRK_MB}MB\"

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
    -c \"ALTER SYSTEM SET max_connections        = 120;\" \\
    -c \"ALTER SYSTEM SET checkpoint_completion_target = '0.9';\" \
    -c \"ALTER SYSTEM SET random_page_cost       = '1.1';\" \
    -c \"ALTER SYSTEM SET pg_stat_statements.track = 'all';\" \
    2>&1 | grep -v 'change directory' || true

  # shared_buffers requires a full restart (postmaster context);
  # other params take effect after pg_reload_conf().
  sudo systemctl restart postgresql
  sleep 2
  sudo systemctl is-active postgresql \
    || { echo 'ERROR: PostgreSQL failed to start after tuning'; exit 1; }
  # Enable pg_stat_statements extension in the DB (idempotent, needs preload above)
  sudo -u postgres psql chatapp_staging -qAt \
    -c \"CREATE EXTENSION IF NOT EXISTS pg_stat_statements;\" \
    2>&1 | grep -v 'change directory' || true
  echo 'PostgreSQL tuning applied and restarted.'
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
scp deploy/health-check.sh deploy/smoke-test.sh deploy/pgbouncer-setup.py "${STAGING_USER}@${STAGING_HOST}:/tmp/"
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
  # PG_POOL_MAX: Node→PgBouncer virtual connections per instance.  With 2
  # instances × 50 = 100 total Node connections against pgbouncer
  # default_pool_size=80 real PG backends (1.25:1 ratio).  Raising this above
  # 50 causes PgBouncer to become the bottleneck before the Node-level circuit
  # breaker can fire, producing slow timeout failures instead of fast 503s.
  sudo grep -q '^PG_POOL_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # POOL_CIRCUIT_BREAKER_QUEUE: number of requests allowed to wait for a pool
  # connection before we start returning 503. Raised to 400 so burst traffic is
  # buffered (messages succeed with latency) rather than failed immediately.
  # PG_CONNECTION_TIMEOUT_MS=10000 gives each queued request up to 10s to get a
  # connection before timing out — long enough for the pool to drain under
  # normal burst conditions while still bounding worst-case wait time.
  sudo grep -q '^POOL_CIRCUIT_BREAKER_QUEUE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^POOL_CIRCUIT_BREAKER_QUEUE=.*/POOL_CIRCUIT_BREAKER_QUEUE=400/' /opt/chatapp/shared/.env \
    || echo 'POOL_CIRCUIT_BREAKER_QUEUE=400' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_CONNECTION_TIMEOUT_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_CONNECTION_TIMEOUT_MS=.*/PG_CONNECTION_TIMEOUT_MS=10000/' /opt/chatapp/shared/.env \
    || echo 'PG_CONNECTION_TIMEOUT_MS=10000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY: 1 per instance on staging — with
  # CHATAPP_INSTANCES>=2 that means up to 2 total indexing jobs in flight
  # across the cluster, which matches the 2-CPU budget without over-subscribing.
  sudo grep -q '^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=.*/SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1/' /opt/chatapp/shared/.env \
    || echo 'SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # FANOUT_QUEUE_CONCURRENCY: parallel fanout:critical workers per instance.
  # 4 concurrent fanout jobs on staging (2-vCPU, 2 instances) — allows bursting
  # through queued publishes without serialising on a single worker.
  sudo grep -q '^FANOUT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^FANOUT_QUEUE_CONCURRENCY=.*/FANOUT_QUEUE_CONCURRENCY=4/' /opt/chatapp/shared/.env \
    || echo 'FANOUT_QUEUE_CONCURRENCY=4' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
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

echo "6) Running health and smoke checks on candidate..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  /tmp/health-check.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
  /tmp/smoke-test.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
"

echo "7) Switching Nginx upstream from ${LIVE_PORT} to ${CANDIDATE_PORT}..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  sudo sed -i 's/127.0.0.1:${LIVE_PORT}/127.0.0.1:${CANDIDATE_PORT}/g' /etc/nginx/sites-available/chatapp
  sudo nginx -t
  sudo systemctl reload nginx
"
CUTOVER_COMPLETED=1

echo "7a) Prometheus scrape config check (staging always runs both 4000+4001)..."
# Staging runs CHATAPP_INSTANCES>=2 so both ports are always in the Prometheus
# config — no port substitution needed. Just verify the container is healthy.
ssh "${STAGING_USER}@${STAGING_HOST}" "
  if sudo docker inspect chatapp-monitoring-prometheus-1 >/dev/null 2>&1; then
    STATUS=\$(sudo docker inspect -f '{{.State.Running}}' chatapp-monitoring-prometheus-1)
    echo \"Prometheus container running=\$STATUS\"
  else
    echo 'WARN: Prometheus container not found (non-critical)'
  fi
" || echo "Warning: Prometheus check failed (non-critical)" >&2

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
