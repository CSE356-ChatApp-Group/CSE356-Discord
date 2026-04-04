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

echo "=== PRODUCTION DEPLOYMENT ==="
echo "Release: $RELEASE_SHA"
echo "Target: $PROD_USER@$PROD_HOST"
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
scp "${SCRIPT_DIR}/health-check.sh" "${SCRIPT_DIR}/smoke-test.sh" "$PROD_USER@$PROD_HOST:/tmp/"
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

# 9. Switch Nginx
echo "9. Switching Nginx to candidate..."
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  
  # Update Nginx upstream
  sudo sed -i -E \"s/(127\\\\.0\\\\.0\\\\.1|localhost):$OLD_PORT/localhost:$NEW_PORT/g\" /etc/nginx/sites-available/chatapp
  # Ensure listen backlog is high enough for burst connection ramps.
  sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' /etc/nginx/sites-available/chatapp
  sudo sed -i 's/listen \[::\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' /etc/nginx/sites-available/chatapp
  sudo nginx -t >/dev/null
  sudo systemctl reload nginx
  # Raise kernel TCP backlog so burst connection ramps don't drop SYN packets.
  sudo sysctl -w net.ipv4.tcp_max_syn_backlog=4096 >/dev/null
  sudo sysctl -w net.core.somaxconn=4096 >/dev/null
  
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
for i in $(seq 1 "$MONITOR_CHECKS"); do
  sleep 5
  if ssh "$PROD_USER@$PROD_HOST" "/tmp/health-check.sh $NEW_PORT http://127.0.0.1:$NEW_PORT" >/dev/null 2>&1; then
    echo "  ✓ Check $i/$MONITOR_CHECKS passed"
  else
    echo "  ⚠ Check $i/$MONITOR_CHECKS: health check failed"
  fi
done
echo "✓ Monitoring window complete"

# 11. Update current symlink
echo "11. Updating current release symlink..."
if ssh "$PROD_USER@$PROD_HOST" "
  ln -sfn $RELEASE_DIR/$RELEASE_SHA $CURRENT_LINK
  echo 'Symlink: $CURRENT_LINK -> $RELEASE_SHA'
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
  echo "⚠ WARNING: Final check failed. Manual inspection recommended."
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
echo "Previous version still running on port $OLD_PORT for rollback."
echo ""
echo "To rollback immediately:"
echo "  ssh $PROD_USER@$PROD_HOST 'sudo sed -i -E \"s/(127\\.0\\.0\\.1|localhost):$NEW_PORT/localhost:$OLD_PORT/g\" /etc/nginx/sites-available/chatapp && sudo nginx -t && sudo systemctl reload nginx'"
echo ""
echo "To stop the old version after confidence window (keep for ~10 min):"
echo "  ssh $PROD_USER@$PROD_HOST 'systemctl stop chatapp@$OLD_PORT'"
