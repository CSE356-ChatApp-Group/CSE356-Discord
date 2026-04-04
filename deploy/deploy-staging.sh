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
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  LIVE_PORT='${LIVE_PORT}'
  sudo tee /etc/nginx/sites-available/chatapp >/dev/null <<'EOF'
upstream chatapp_upstream {
  server 127.0.0.1:__LIVE_PORT__;
  keepalive 128;
  keepalive_requests 10000;
  keepalive_timeout 75s;
}

server {
  listen 80 default_server backlog=4096;
  listen [::]:80 default_server backlog=4096;
  server_name _;

  location /ws {
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \"upgrade\";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
  }

  location /api/ {
    proxy_pass http://chatapp_upstream;
    proxy_http_version 1.1;
    proxy_set_header Connection \"\";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 30s;
    client_max_body_size 10m;
  }

  location /health {
    proxy_pass http://chatapp_upstream/health;
    access_log off;
  }

  location = /grafana {
    return 301 /grafana/;
  }

  location /grafana/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Prefix /grafana;
    proxy_redirect ~^/(.*)$ /grafana/\$1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
  }

  location / {
    root /opt/chatapp/current/frontend/dist;
    try_files \$uri /index.html;
  }

  location = /index.html {
    root /opt/chatapp/current/frontend/dist;
    add_header Cache-Control \"no-store\";
  }

  location /assets/ {
    root /opt/chatapp/current/frontend/dist;
    try_files \$uri =404;
    expires 1h;
    add_header Cache-Control \"public, max-age=3600\";
  }
}
EOF
  sudo sed -i \"s/__LIVE_PORT__/\${LIVE_PORT}/g\" /etc/nginx/sites-available/chatapp
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
scp deploy/health-check.sh deploy/smoke-test.sh "${STAGING_USER}@${STAGING_HOST}:/tmp/"
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
  # BCRYPT_ROUNDS=8: ~125ms/op on a 2-vCPU Xeon vs ~500ms at rounds=10.
  sudo grep -q '^BCRYPT_ROUNDS=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^BCRYPT_ROUNDS=.*/BCRYPT_ROUNDS=8/' /opt/chatapp/shared/.env \
    || echo 'BCRYPT_ROUNDS=8' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # UV_THREADPOOL_SIZE: increase libuv thread pool for concurrent bcrypt/dns/fs work.
  sudo grep -q '^UV_THREADPOOL_SIZE=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^UV_THREADPOOL_SIZE=.*/UV_THREADPOOL_SIZE=8/' /opt/chatapp/shared/.env \
    || echo 'UV_THREADPOOL_SIZE=8' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
  # PG_POOL_MAX=250: PG max_connections=300; 250 maximises pool while leaving ~50 for admin/maintenance
  # without exhausting the server budget. Previous manual value was 100 (break at ~130 iters/s).
  sudo grep -q '^PG_POOL_MAX=' /opt/chatapp/shared/.env \
    && sudo sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=250/' /opt/chatapp/shared/.env \
    || echo 'PG_POOL_MAX=250' | sudo tee -a /opt/chatapp/shared/.env > /dev/null
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

echo "7a) Updating Prometheus scrape target to new live port ${CANDIDATE_PORT}..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  # Try common Prometheus config locations; update the API scrape target port.
  for PROM_CFG in /etc/prometheus/prometheus.yml /opt/prometheus/prometheus.yml; do
    if [ -f \"\$PROM_CFG\" ]; then
      sudo sed -i 's/127\.0\.0\.1:${LIVE_PORT}/127.0.0.1:${CANDIDATE_PORT}/g' \"\$PROM_CFG\"
      # Reload Prometheus if running (ignore errors — monitoring is non-critical).
      curl -fsS -X POST 'http://127.0.0.1:9090/-/reload' 2>/dev/null || true
      echo \"Updated Prometheus config at \$PROM_CFG\"
      break
    fi
  done
" || echo "Warning: Prometheus config update failed (non-critical)" >&2

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
echo "- Previous version was kept for rollback"
echo "- Deployment used immutable release dir: ${RELEASE_DIR}/${RELEASE_SHA}"

echo ""
echo "Rollback (immediate — old release still running on port ${LIVE_PORT}):"
echo "  ssh ${STAGING_USER}@${STAGING_HOST} 'sudo sed -i \"s/127.0.0.1:${CANDIDATE_PORT}/127.0.0.1:${LIVE_PORT}/g\" /etc/nginx/sites-available/chatapp && sudo nginx -t && sudo systemctl reload nginx'"
echo ""
echo "To stop the old version after confidence window:"
echo "  ssh ${STAGING_USER}@${STAGING_HOST} 'sudo systemctl stop chatapp@${LIVE_PORT}'"
