#!/bin/bash
# deploy/deploy-staging.sh
# Deploy CI-built artifact to staging using candidate-port cutover.
# Usage: ./deploy/deploy-staging.sh <release-sha>

set -euo pipefail

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy/deploy-staging.sh <sha>}
STAGING_HOST="${STAGING_HOST:-136.114.103.71}"
STAGING_USER="${STAGING_USER:-$USER}"
GITHUB_REPO="${GITHUB_REPO:-CSE356-ChatApp-Group/CSE356-Discord}"
RELEASE_DIR="/opt/chatapp/releases"
CURRENT_LINK="/opt/chatapp/current"
CANDIDATE_PORT=4001
LIVE_PORT=4000
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

echo "0) Ensuring Nginx serves frontend UI and proxies backend routes..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  LIVE_PORT='${LIVE_PORT}'
  sudo tee /etc/nginx/sites-available/chatapp >/dev/null <<'EOF'
upstream chatapp_upstream {
  server 127.0.0.1:__LIVE_PORT__;
  keepalive 32;
}

server {
  listen 80 default_server;
  listen [::]:80 default_server;
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
"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) is required for artifact download."
  exit 1
fi

ARTIFACT="chatapp-${RELEASE_SHA}.tar.gz"
LOCAL_ARTIFACT="/tmp/${ARTIFACT}"

echo "1) Downloading CI-built artifact for ${RELEASE_SHA}..."
gh release download "release-${RELEASE_SHA}" -R "${GITHUB_REPO}" -p "${ARTIFACT}" -O "${LOCAL_ARTIFACT}"

echo "2) Copying artifact and verification scripts to staging host..."
scp "${LOCAL_ARTIFACT}" "${STAGING_USER}@${STAGING_HOST}:/tmp/${ARTIFACT}"
scp deploy/health-check.sh deploy/smoke-test.sh "${STAGING_USER}@${STAGING_HOST}:/tmp/"
rm -f "${LOCAL_ARTIFACT}"

echo "3) Unpacking artifact into immutable release directory..."
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
  node "\${RELEASE_PATH}/backend/dist/db/migrate.js"

  chmod +x /tmp/health-check.sh /tmp/smoke-test.sh
"

echo "4) Starting candidate app on port ${CANDIDATE_PORT}..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  RELEASE_PATH='${RELEASE_DIR}/${RELEASE_SHA}'

  if lsof -i :${CANDIDATE_PORT} >/dev/null 2>&1; then
    echo 'Candidate port ${CANDIDATE_PORT} is already in use; attempting stale process cleanup...'
    PIDS=\$(lsof -ti :${CANDIDATE_PORT} | sort -u)
    for PID in \$PIDS; do
      kill \"\$PID\" || true
    done
    sleep 2
    if lsof -i :${CANDIDATE_PORT} >/dev/null 2>&1; then
      echo 'ERROR: Candidate port ${CANDIDATE_PORT} still in use after cleanup.'
      exit 1
    fi
  fi

  cd \"\${RELEASE_PATH}\"
  set -a
  source /opt/chatapp/shared/.env
  set +a
  export NODE_ENV=staging
  export PORT=${CANDIDATE_PORT}
  nohup npm --prefix backend start > /tmp/chatapp-${RELEASE_SHA}-candidate.log 2>&1 &
  echo \$! > /tmp/chatapp-${RELEASE_SHA}-candidate.pid

  sleep 4
  kill -0 \$(cat /tmp/chatapp-${RELEASE_SHA}-candidate.pid)
"

echo "5) Running health and smoke checks on candidate..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  /tmp/health-check.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
  /tmp/smoke-test.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}
"

echo "6) Switching Nginx upstream from ${LIVE_PORT} to ${CANDIDATE_PORT}..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  sudo sed -i 's/127.0.0.1:${LIVE_PORT}/127.0.0.1:${CANDIDATE_PORT}/g' /etc/nginx/sites-available/chatapp
  sudo nginx -t
  sudo systemctl reload nginx
"

echo "7) Updating current symlink to new release..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  ln -sfn '${RELEASE_DIR}/${RELEASE_SHA}' '${CURRENT_LINK}'
"

echo "8) Post-cutover verification..."
ssh "${STAGING_USER}@${STAGING_HOST}" "/tmp/health-check.sh ${CANDIDATE_PORT} http://127.0.0.1:${CANDIDATE_PORT}"

echo "9) Verifying frontend root from Nginx..."
ssh "${STAGING_USER}@${STAGING_HOST}" "
  set -euo pipefail
  curl -fsS http://127.0.0.1/ >/dev/null
"

echo ""
echo "Staging deployment successful."
echo "- Candidate used port: ${CANDIDATE_PORT}"
echo "- Live traffic now points to: ${CANDIDATE_PORT}"
echo "- Previous version was kept for rollback"
echo "- Deployment used immutable release dir: ${RELEASE_DIR}/${RELEASE_SHA}"

echo ""
echo "Rollback (immediate):"
echo "  ssh ${STAGING_USER}@${STAGING_HOST} 'sudo sed -i \"s/127.0.0.1:${CANDIDATE_PORT}/127.0.0.1:${LIVE_PORT}/g\" /etc/nginx/sites-available/chatapp && sudo nginx -t && sudo systemctl reload nginx'"
