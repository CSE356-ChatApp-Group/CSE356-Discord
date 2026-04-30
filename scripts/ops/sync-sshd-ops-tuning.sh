#!/usr/bin/env bash
# Push deploy/sshd-99-chatapp-ops-tuning.conf to staging/prod and reload ssh.
# Usage:
#   ./scripts/ops/sync-sshd-ops-tuning.sh
#   STAGING_USER=ssperrottet STAGING_HOST=136.114.103.71 PROD_USER=ubuntu PROD_HOST=130.245.136.44 ./scripts/ops/sync-sshd-ops-tuning.sh
set -euo pipefail
set -o pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"
CONF="${CHATAPP_REPO_ROOT}/deploy/sshd-99-chatapp-ops-tuning.conf"
STAGING_USER="${STAGING_USER:-ssperrottet}"
STAGING_HOST="${STAGING_HOST:-136.114.103.71}"
PROD_USER="${PROD_USER:-ubuntu}"
PROD_HOST="${PROD_HOST:-130.245.136.44}"
REMOTE_PATH=/etc/ssh/sshd_config.d/99-chatapp-ops-tuning.conf

sync_one() {
  local user="$1" host="$2"
  echo "=== $user@$host ==="
  scp -o BatchMode=yes -o ConnectTimeout=20 "$CONF" "${user}@${host}:/tmp/sshd-99-chatapp.conf"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "${user}@${host}" \
    "sudo mv /tmp/sshd-99-chatapp.conf ${REMOTE_PATH} && sudo chown root:root ${REMOTE_PATH} && sudo chmod 644 ${REMOTE_PATH} && sudo sshd -t && sudo systemctl reload ssh && echo OK"
}

sync_one "$STAGING_USER" "$STAGING_HOST"
for attempt in 1 2 3 4 5 6; do
  if sync_one "$PROD_USER" "$PROD_HOST"; then
    exit 0
  fi
  echo "prod sync attempt $attempt failed, sleeping 3s..."
  sleep 3
done
exit 1
