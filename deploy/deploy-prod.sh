#!/bin/bash
# deploy/deploy-prod.sh
# Deploy to production using candidate-port cutover.
# Usage: ./deploy-prod.sh <release-sha>

set -euo pipefail

RELEASE_SHA=${1:?Release SHA required. Usage: ./deploy-prod.sh <sha>}
PROD_HOST="${PROD_HOST:-136.114.103.71}"
PROD_USER="${PROD_USER:-ssperrottet}"
GITHUB_REPO="${GITHUB_REPO:-CSE356-ChatApp-Group/CSE356-Discord}"
RELEASE_DIR="/opt/chatapp/releases"
CURRENT_LINK="/opt/chatapp/current"
OLD_PORT=4000
NEW_PORT=4001
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== PRODUCTION DEPLOYMENT ==="
echo "Release: $RELEASE_SHA"
echo "Target: $PROD_HOST"
"${SCRIPT_DIR}/preflight-check.sh" prod "$RELEASE_SHA" "$PROD_USER" "$PROD_HOST" "$GITHUB_REPO"
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
echo "1. Verifying artifact exists..."
if ! gh release view "release-${RELEASE_SHA}" -R "$GITHUB_REPO" >/dev/null 2>&1; then
  echo "ERROR: Release not found. Check SHA and GitHub access."
  exit 1
fi
echo "✓ Release found"

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

# 3. Download artifact to prod
echo "3. Downloading artifact..."
DOWNLOAD_PATH="/tmp/chatapp-${RELEASE_SHA}.tar.gz"
gh release download "release-${RELEASE_SHA}" -R "$GITHUB_REPO" \
  -p "chatapp-${RELEASE_SHA}.tar.gz" -O "$DOWNLOAD_PATH" || {
  echo "ERROR: Failed to download artifact."
  exit 1
}
echo "✓ Downloaded locally"

# 4. Copy to production server
echo "4. Copying to production..."
scp "$DOWNLOAD_PATH" "$PROD_USER@$PROD_HOST:/tmp/"
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
  
  echo 'Release unpacked and verified'
"
echo "✓ Candidate release ready"

# 6. Start candidate on alternate port
echo "6. Starting candidate process..."
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  RELEASE_PATH=$RELEASE_DIR/$RELEASE_SHA
  
  cd \$RELEASE_PATH
  set -a
  source /opt/chatapp/shared/.env
  set +a
  export NODE_ENV=production
  export PORT=$NEW_PORT
  
  # Kill any existing process on the candidate port
  if lsof -i :$NEW_PORT >/dev/null 2>&1; then
    echo 'Killing existing process on port $NEW_PORT'
    lsof -ti :$NEW_PORT | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
  
  # Start candidate in background
  nohup npm --prefix backend start > /var/log/chatapp-candidate.log 2>&1 &
  CANDIDATE_PID=\$!
  echo \$CANDIDATE_PID > /tmp/chatapp-candidate.pid
  
  # Wait for startup
  sleep 4
  
  if ! kill -0 \$CANDIDATE_PID 2>/dev/null; then
    echo 'ERROR: Candidate process exited immediately'
    tail -30 /var/log/chatapp-candidate.log
    exit 1
  fi
  
  echo 'Candidate process started (PID: '\$CANDIDATE_PID')'
"
echo "✓ Candidate process started on port $NEW_PORT"

# 7. Health checks
echo "7. Running health checks on candidate..."
bash ./health-check.sh $NEW_PORT "http://${PROD_HOST}:${NEW_PORT}" || {
  echo "ERROR: Health check failed. Stopping candidate."
  ssh "$PROD_USER@$PROD_HOST" "kill \$(cat /tmp/chatapp-candidate.pid) || true; rm /tmp/chatapp-candidate.pid"
  exit 1
}
echo "✓ Health checks passed"

# 8. Smoke tests
echo "8. Running smoke tests..."
bash ./smoke-test.sh $NEW_PORT "http://${PROD_HOST}:${NEW_PORT}" || {
  echo "ERROR: Smoke tests failed. Stopping candidate."
  ssh "$PROD_USER@$PROD_HOST" "kill \$(cat /tmp/chatapp-candidate.pid) || true; rm /tmp/chatapp-candidate.pid"
  exit 1
}
echo "✓ Smoke tests passed"

# 9. Switch Nginx
echo "9. Switching Nginx to candidate..."
ssh "$PROD_USER@$PROD_HOST" "
  set -e
  
  # Update Nginx upstream
  sudo sed -i 's/localhost:$OLD_PORT/localhost:$NEW_PORT/' /etc/nginx/sites-available/chatapp
  sudo nginx -t >/dev/null
  sudo systemctl reload nginx
  
  echo 'Nginx upstream switched to port $NEW_PORT'
"
echo "✓ Nginx switched to new version"

# 10. Monitor briefly
echo "10. Monitoring for 60 seconds..."
for i in {1..12}; do
  sleep 5
  if bash ./health-check.sh $NEW_PORT "http://${PROD_HOST}:${NEW_PORT}" 2>/dev/null; then
    echo "  ✓ Check $i/12 passed"
  else
    echo "  ⚠ Check $i/12: health check failed"
  fi
done
echo "✓ Monitoring window complete"

# 11. Update current symlink
echo "11. Updating current release symlink..."
ssh "$PROD_USER@$PROD_HOST" "
  ln -sfn $RELEASE_DIR/$RELEASE_SHA $CURRENT_LINK
  echo 'Symlink: $CURRENT_LINK -> $RELEASE_SHA'
"
echo "✓ Symlink updated"

# 12. Final health check
echo "12. Final verification..."
if bash ./health-check.sh $NEW_PORT "http://${PROD_HOST}:${NEW_PORT}" 2>/dev/null; then
  echo "✓ Production deployment SUCCESSFUL"
else
  echo "⚠ WARNING: Final check failed. Manual inspection recommended."
fi

echo ""
echo "=== Deployment Complete ==="
echo "Release: $RELEASE_SHA"
echo "Production: https://$(echo $PROD_HOST | sed 's/.internal.*//')"
echo ""
echo "Previous version still running on port $OLD_PORT for rollback."
echo ""
echo "To rollback immediately:"
echo "  ssh $PROD_USER@$PROD_HOST 'sudo sed -i \"s/localhost:$NEW_PORT/localhost:$OLD_PORT/\" /etc/nginx/sites-available/chatapp && sudo systemctl reload nginx'"
echo ""
echo "To stop the old version after confidence window (keep for ~10 min):"
echo "  ssh $PROD_USER@$PROD_HOST 'pkill -f \"PORT=$OLD_PORT\" || true'"
