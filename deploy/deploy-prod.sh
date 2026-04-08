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
MONITOR_SECONDS="${MONITOR_SECONDS:-30}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
NGINX_WORKER_CONNECTIONS="${NGINX_WORKER_CONNECTIONS:-16384}"
ALLOW_DB_RESTART="${ALLOW_DB_RESTART:-false}"
RECLAIM_OLD_PORT="${RECLAIM_OLD_PORT:-false}"

# Number of Node.js HTTP workers (systemd chatapp@ ports).  Default 1; set 2 when
# nginx load-balances two ports like staging.
CHATAPP_INSTANCES=${CHATAPP_INSTANCES:-1}
_REMOTE_NCPU=$(ssh "${PROD_USER}@${PROD_HOST}" 'nproc --all' 2>/dev/null || echo 2)
# PgBouncer pool + Node pool math matches deploy-staging.sh (same caps, different host).
_PGB_SIZE=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = int('${CHATAPP_INSTANCES}')
x = max(60, min(320, ncpu * 50, 80 + inst * 45))
print(x)
")
PG_POOL_MAX_PER_INSTANCE=$(python3 -c "
p = int('${_PGB_SIZE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
print(max(25, min(140, (p * 5) // (inst * 2))))
")
POOL_CIRCUIT_BREAKER_QUEUE=$(python3 -c "
pmi = int('${PG_POOL_MAX_PER_INSTANCE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
print(max(64, min(900, pmi * 4 + inst * 80)))
")
PG_MAX_CONNECTIONS=$(python3 -c "
b = int('${_PGB_SIZE}')
print(max(120, min(450, b + 60)))
")
BCRYPT_MAX_CONCURRENT=$(python3 -c "
n = int('${_REMOTE_NCPU}')
print(min(32, max(8, n * 4)))
")
FANOUT_QUEUE_CONCURRENCY=$(python3 -c "
n = int('${_REMOTE_NCPU}')
print(min(12, max(2, (n + 1) // 2 + 1)))
")
UV_THREADPOOL_PER_INSTANCE=$(python3 -c "print(max(8, 16 // max(1, ${CHATAPP_INSTANCES})))")
# V8 max-old-space per instance: cap heap below the OOM killer threshold.
# Formula: min(1500, max(RAM_MB * 12%, 192)) — same as deploy-staging.sh.
# On a 2 GB prod machine: min(1500, max(246, 192)) = 246 MB.
_REMOTE_RAM_MB=$(ssh "${PROD_USER}@${PROD_HOST}" "awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo" 2>/dev/null || echo 2048)
NODE_OLD_SPACE_MB=$(python3 -c "print(min(1500, max(192, ${_REMOTE_RAM_MB} * 12 // 100 // ${CHATAPP_INSTANCES})))")

echo "=== PRODUCTION DEPLOYMENT ==="
echo "Release: $RELEASE_SHA"
echo "Target: $PROD_USER@$PROD_HOST"
echo "  VM vCPUs: ${_REMOTE_NCPU}  workers: ${CHATAPP_INSTANCES}  pgbouncer_pool: ${_PGB_SIZE}  pg_max_conn: ${PG_MAX_CONNECTIONS}"
echo "  PG_POOL_MAX/instance: ${PG_POOL_MAX_PER_INSTANCE}  pool_circuit_queue: ${POOL_CIRCUIT_BREAKER_QUEUE}"
"${SCRIPT_DIR}/preflight-check.sh" prod "$RELEASE_SHA" "$PROD_USER" "$PROD_HOST" "$GITHUB_REPO"

CURRENT_UPSTREAM_PORT=$(ssh "$PROD_USER@$PROD_HOST" "grep -oE '(127\\.0\\.0\\.1|localhost):[0-9]+' /etc/nginx/sites-available/chatapp | head -n1 | cut -d: -f2" || true)
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

rollback_cutover() {
  echo "↩ Rolling back nginx upstream ${NEW_PORT} -> ${OLD_PORT}..."
  ssh "$PROD_USER@$PROD_HOST" "
    set -euo pipefail
    TMP_SITE=\$(mktemp)
    sudo cp /etc/nginx/sites-available/chatapp \"\$TMP_SITE\"
    sudo sed -i -E \"s/(127\\\\.0\\\\.0\\\\.1|localhost):${NEW_PORT}/localhost:${OLD_PORT}/g\" \"\$TMP_SITE\"
    sudo sed -i -E '/max_fails/!s/^([[:space:]]*server[[:space:]]+(127\\.0\\.0\\.1|localhost):[0-9]+);/\\1 max_fails=0;/' \"\$TMP_SITE\"
    sudo install -m 644 \"\$TMP_SITE\" /etc/nginx/sites-available/chatapp
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
    sudo systemctl start chatapp@${OLD_PORT} 2>/dev/null || true
  "
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

# 2. Backup database before risky deploy
echo "2. Backing up database..."
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  BACKUP_DIR=/opt/chatapp/backups
  mkdir -p \$BACKUP_DIR
  BACKUP_FILE=\$BACKUP_DIR/postgres-backup-\$(date +%Y%m%d-%H%M%S).sql
  
  source /opt/chatapp/shared/.env
  pg_dump \"\$DATABASE_URL\" | gzip > \$BACKUP_FILE
  
  echo 'Backup created: '\$BACKUP_FILE
  ls -lh \$BACKUP_FILE
" || {
  echo "WARNING: Database backup failed, but continuing"
}
echo "✓ Backup prepared"

# 2b. Install/configure PgBouncer (idempotent — safe on every deploy)
echo "2b) Installing and configuring PgBouncer..."
scp "${SCRIPT_DIR}/pgbouncer-setup.py" "${PROD_USER}@${PROD_HOST}:/tmp/pgbouncer-setup.py"
ssh "$PROD_USER@$PROD_HOST" "
  set -euo pipefail
  if ! dpkg -l pgbouncer 2>/dev/null | grep -q '^ii'; then
    sudo apt-get install -y pgbouncer
    echo 'PgBouncer installed.'
  fi
  sudo env PGBOUNCER_POOL_SIZE=${_PGB_SIZE} python3 /tmp/pgbouncer-setup.py
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

# 2c. PostgreSQL tuning (conservative for 2 GB prod VM)
echo "2c) Tuning PostgreSQL for prod VM..."
ssh "$PROD_USER@$PROD_HOST" "
  set -euo pipefail
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
ssh "$PROD_USER@$PROD_HOST" "
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
  
  # Frontend is pre-built, but verify
  if [ ! -d \$RELEASE_PATH/frontend/dist ]; then
    echo 'ERROR: Frontend dist not found in artifact'
    exit 1
  fi

  chmod +x /tmp/health-check.sh /tmp/smoke-test.sh
  
  echo 'Release unpacked and verified'
"
echo "✓ Candidate release ready"

# 5.5. Install/update systemd unit
echo "5.5. Installing/updating systemd unit..."
# Use ssh stdin pipe instead of scp: OpenSSH >=9.0 switches scp to the SFTP
# subsystem which misparses '@' in remote paths, causing "Permission denied".
ssh "$PROD_USER@$PROD_HOST" 'cat > /tmp/chatapp-template.service' < "${SCRIPT_DIR}/chatapp-template.service"
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  sed 's/__DEPLOY_USER__/${PROD_USER}/g' /tmp/chatapp-template.service | sudo tee /etc/systemd/system/chatapp@.service > /dev/null
  # PORT must not be in shared .env — systemd provides it via Environment=PORT=%i
  sudo sed -i '/^PORT=/d' /opt/chatapp/shared/.env
  # Ensure performance-critical env vars are set for this deployment.
  sudo grep -q '^BCRYPT_ROUNDS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_ROUNDS=.*/BCRYPT_ROUNDS=8/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_ROUNDS=8' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^UV_THREADPOOL_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^UV_THREADPOOL_SIZE=.*/UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'UV_THREADPOOL_SIZE=${UV_THREADPOOL_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_POOL_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}/' /opt/chatapp/shared/.env \
    || echo 'PG_POOL_MAX=${PG_POOL_MAX_PER_INSTANCE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # POOL_CIRCUIT_BREAKER_QUEUE: number of requests allowed to wait for a pool
  # connection before returning 503. Raised to 400 so burst traffic is buffered
  # (messages succeed with latency) rather than failed immediately.
  # PG_CONNECTION_TIMEOUT_MS=10000 gives each queued request up to 10s to get a
  # connection before timing out.
  sudo grep -q '^POOL_CIRCUIT_BREAKER_QUEUE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^POOL_CIRCUIT_BREAKER_QUEUE=.*/POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}/' /opt/chatapp/shared/.env \
    || echo 'POOL_CIRCUIT_BREAKER_QUEUE=${POOL_CIRCUIT_BREAKER_QUEUE}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^BCRYPT_MAX_CONCURRENT=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_MAX_CONCURRENT=.*/BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_MAX_CONCURRENT=${BCRYPT_MAX_CONCURRENT}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo grep -q '^PG_CONNECTION_TIMEOUT_MS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_CONNECTION_TIMEOUT_MS=.*/PG_CONNECTION_TIMEOUT_MS=10000/' /opt/chatapp/shared/.env \
    || echo 'PG_CONNECTION_TIMEOUT_MS=10000' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # HTTP shedding is opt-in in code; keep prod explicit so a refactor never turns it on by default.
  sudo grep -q '^OVERLOAD_HTTP_SHED_ENABLED=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^OVERLOAD_HTTP_SHED_ENABLED=.*/OVERLOAD_HTTP_SHED_ENABLED=false/' /opt/chatapp/shared/.env \
    || echo 'OVERLOAD_HTTP_SHED_ENABLED=false' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY: 1 on the 1-CPU prod VM so async
  # search-indexing side effects don't compete with request handling.
  sudo grep -q '^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=.*/SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1/' /opt/chatapp/shared/.env \
    || echo 'SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # FANOUT_QUEUE_CONCURRENCY: parallel fanout:critical workers per instance.
  # Prod has 1 CPU so 2 concurrent fanout jobs is enough — keeps queue latency
  # low without over-parallelising on a single core.
  sudo grep -q '^FANOUT_QUEUE_CONCURRENCY=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^FANOUT_QUEUE_CONCURRENCY=.*/FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}/' /opt/chatapp/shared/.env \
    || echo 'FANOUT_QUEUE_CONCURRENCY=${FANOUT_QUEUE_CONCURRENCY}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # NODE_OPTIONS: set V8 heap limit so GC pressure triggers before the OOM
  # killer fires.  NODE_OLD_SPACE_MB is computed from remote RAM / instances.
  sudo grep -q '^NODE_OPTIONS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^NODE_OPTIONS=.*/NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}/' /opt/chatapp/shared/.env \
    || echo 'NODE_OPTIONS=--max-old-space-size=${NODE_OLD_SPACE_MB}' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  sudo systemctl daemon-reload
  echo 'systemd unit installed'"
echo "✓ systemd unit ready"

# 6. Start candidate on alternate port via systemd
echo "6. Starting candidate process via systemd..."
ssh "$PROD_USER@$PROD_HOST" "
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
ssh "$PROD_USER@$PROD_HOST" "/tmp/health-check.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" || {
  echo "ERROR: Health check failed. Stopping candidate."
  ssh "$PROD_USER@$PROD_HOST" "sudo systemctl stop chatapp@${NEW_PORT} || true"
  exit 1
}
echo "✓ Health checks passed"

# 8. Smoke tests
echo "8. Running smoke tests..."
ssh "$PROD_USER@$PROD_HOST" "/tmp/smoke-test.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" || {
  echo "ERROR: Smoke tests failed. Stopping candidate."
  ssh "$PROD_USER@$PROD_HOST" "sudo systemctl stop chatapp@${NEW_PORT} || true"
  exit 1
}
echo "✓ Smoke tests passed"

echo "8b. Candidate WebSocket message round-trip..."
ssh "$PROD_USER@$PROD_HOST" "
  set -euo pipefail
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
  export API_CONTRACT_BASE_URL=http://127.0.0.1:$NEW_PORT/api/v1
  export API_CONTRACT_WS_URL=ws://127.0.0.1:$NEW_PORT/ws
  cp /tmp/candidate-ws-smoke.cjs \"\$RELEASE_PATH/backend/candidate-ws-smoke.cjs\"
  cd \"\$RELEASE_PATH/backend\" && node ./candidate-ws-smoke.cjs
  rm -f \"\$RELEASE_PATH/backend/candidate-ws-smoke.cjs\"
" || {
  echo "ERROR: Candidate WS smoke failed. Stopping candidate."
  ssh "$PROD_USER@$PROD_HOST" "sudo systemctl stop chatapp@${NEW_PORT} || true"
  exit 1
}
echo "✓ Candidate WS smoke passed"

# 9. Switch Nginx
echo "9. Switching Nginx to candidate..."
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  
  # Render nginx config atomically, then swap in one operation.
  TMP_SITE=\$(mktemp)
  sudo cp /etc/nginx/sites-available/chatapp \"\$TMP_SITE\"
  sudo sed -i -E \"s/(127\\\\.0\\\\.0\\\\.1|localhost):$OLD_PORT/localhost:$NEW_PORT/g\" \"\$TMP_SITE\"
  # Ensure listen backlog is high enough for burst connection ramps.
  sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' \"\$TMP_SITE\"
  sudo sed -i 's/listen \[::\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' \"\$TMP_SITE\"
  # Increase upstream keepalive pool so peak load reuses connections instead of opening new ones.
  sudo sed -i 's/keepalive [0-9]*/keepalive 512/' \"\$TMP_SITE\"
  sudo grep -q 'keepalive_requests' \"\$TMP_SITE\" \
    || sudo sed -i '/keepalive 512/a\\  keepalive_requests 100000;\n  keepalive_timeout 75s;' \"\$TMP_SITE\"
  sudo sed -i 's/keepalive_requests [0-9]*/keepalive_requests 100000/' \"\$TMP_SITE\"
  # Staging parity: never mark Node upstreams \"down\" after transient 503s (prevents death spiral).
  sudo sed -i -E '/max_fails/!s/^([[:space:]]*server[[:space:]]+(127\\.0\\.0\\.1|localhost):[0-9]+);/\\1 max_fails=0;/' \"\$TMP_SITE\"
  sudo install -m 644 \"\$TMP_SITE\" /etc/nginx/sites-available/chatapp
  rm -f \"\$TMP_SITE\"
  sudo nginx -t >/dev/null
  sudo systemctl reload nginx
  # Raise kernel TCP backlog so burst connection ramps don't drop SYN packets.
  sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
  sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
  # Raise nginx worker_connections and FD limit (Ubuntu defaults: 768 connections, 1024 nofile).
  TMP_MAIN=\$(mktemp)
  sudo cp /etc/nginx/nginx.conf \"\$TMP_MAIN\"
  sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' \"\$TMP_MAIN\"
  sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' \"\$TMP_MAIN\"
  # worker_rlimit_nofile lets nginx workers raise their own nofile limit (bypasses OS default 1024).
  sudo grep -q 'worker_rlimit_nofile' \"\$TMP_MAIN\" \
    || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' \"\$TMP_MAIN\"
  sudo install -m 644 \"\$TMP_MAIN\" /etc/nginx/nginx.conf
  rm -f \"\$TMP_MAIN\"
  sudo nginx -t && sudo systemctl reload nginx
  
  echo 'Nginx upstream switched from port $OLD_PORT to $NEW_PORT'
"
echo "✓ Nginx switched to new version"

# 9.5. Enable new service for auto-start on reboot
echo "9.5 Enabling candidate service for auto-start on reboot..."
ssh "$PROD_USER@$PROD_HOST" "sudo systemctl enable chatapp@${NEW_PORT} 2>/dev/null || true"
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
  if ssh "$PROD_USER@$PROD_HOST" "/tmp/health-check.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" >/dev/null 2>&1; then
    echo "  ✓ Check $i/$MONITOR_CHECKS passed"
  else
    echo "  ✗ Check $i/$MONITOR_CHECKS: health check failed"
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
  ssh "$PROD_USER@$PROD_HOST" "
    sudo systemctl stop chatapp@${OLD_PORT} 2>/dev/null || true
    sudo systemctl disable chatapp@${OLD_PORT} 2>/dev/null || true
    echo 'Old instance stopped'"
  echo "✓ Old instance stopped (rollback now requires re-deploy)"
else
  echo "10.5. Keeping old instance on port ${OLD_PORT} for fast rollback safety."
fi

REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 10.55. Copy repo Prometheus template so the `redis` scrape job exists; 10.6 sed still
# rewrites the old live port the same way as before.
echo "10.55. Syncing prometheus-host.yml from repo (includes redis job)..."
scp -q "${REPO_ROOT}/infrastructure/monitoring/prometheus-host.yml" "$PROD_USER@$PROD_HOST:/tmp/prometheus-host.yml.deploy" || true

# 10.6. Update Prometheus scrape target to the new active port.
# prometheus-host.yml is the config template for the monitoring stack.
# We sed-replace the old port, then restart the Prometheus container so its
# entrypoint re-renders the template to /tmp/prometheus.yml automatically.
# (hot-reload via /-/reload requires --web.enable-lifecycle which is not set)
echo "10.6. Updating Prometheus scrape target to port ${NEW_PORT}..."
ssh "$PROD_USER@$PROD_HOST" "
  if [ -f /tmp/prometheus-host.yml.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
    sudo cp /tmp/prometheus-host.yml.deploy /opt/chatapp-monitoring/prometheus-host.yml
    rm -f /tmp/prometheus-host.yml.deploy
  fi
  PROM_TMPL=/opt/chatapp-monitoring/prometheus-host.yml
  if [ -f \"\$PROM_TMPL\" ]; then
    sudo sed -i \"s/127\\.0\\.0\\.1:${OLD_PORT}/127.0.0.1:${NEW_PORT}/g\" \"\$PROM_TMPL\"
    echo \"Updated \$PROM_TMPL: ${OLD_PORT} → ${NEW_PORT}\"
    # Restart the container so its entrypoint re-renders the template into
    # /tmp/prometheus.yml with the correct port and ALERT_ENVIRONMENT substitution.
    if sudo docker restart chatapp-monitoring-prometheus-1 >/dev/null 2>&1; then
      echo \"Prometheus restarted → scraping port ${NEW_PORT}\"
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
ssh "$PROD_USER@$PROD_HOST" "
  set -euo pipefail
  if [ -f /tmp/alerts.yml.deploy ] || [ -f /tmp/alertmanager.yml.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
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
  if ! grep -q '^ALERT_ENVIRONMENT=' /opt/chatapp-monitoring/.env; then
    echo 'ALERT_ENVIRONMENT=production' | sudo tee -a /opt/chatapp-monitoring/.env >/dev/null
  fi
  sudo docker compose --env-file /opt/chatapp-monitoring/.env -f /opt/chatapp-monitoring/remote-compose.yml up -d --force-recreate alertmanager prometheus >/dev/null
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
if ssh "$PROD_USER@$PROD_HOST" "
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
if ssh "$PROD_USER@$PROD_HOST" "/tmp/health-check.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" >/dev/null 2>&1; then
  echo "✓ Production deployment SUCCESSFUL"
else
  echo "ERROR: Final health check failed after cutover."
  rollback_cutover
  exit 1
fi

# 13. Cleanup older releases/backups to control disk usage on small VMs.
echo "13. Pruning old releases/backups (keep releases=$KEEP_RELEASES backups=$KEEP_BACKUPS)..."
if ssh "$PROD_USER@$PROD_HOST" "
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

echo ""
echo "=== Deployment Complete ==="
echo "Release: $RELEASE_SHA"
echo "Production: https://$(echo $PROD_HOST | sed 's/.internal.*//')"
echo ""
echo "To rollback: re-run ./deploy/deploy-prod.sh <previous-sha>"
echo ""
echo "To stop the old version after confidence window (keep for ~10 min):"
echo "  ssh $PROD_USER@$PROD_HOST 'systemctl stop chatapp@$OLD_PORT'"
