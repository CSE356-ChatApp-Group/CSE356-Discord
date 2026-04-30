#!/usr/bin/env bash
# Print Redis SLOWLOG using the same credentials as redis_exporter (argv + REDISCLI_AUTH).
#
# From a machine that can SSH to an app VM with monitoring helpers installed:
#   REDIS_SLOWLOG_SSH=ubuntu@130.245.136.44 ./scripts/redis/redis-slowlog-snapshot.sh
#
# On the app VM (merged .env at default path):
#   ./scripts/redis/redis-slowlog-snapshot.sh
#
# Env: SLOWLOG_N (default 25), ENV_PATH (default /opt/chatapp/shared/.env), REDIS_URL (overrides file).
# Remote-only: REDIS_SLOWLOG_ENV_PATH overrides ENV_PATH on the SSH target (default /opt/chatapp/shared/.env).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"

SLOWLOG_N="${SLOWLOG_N:-25}"
REDIS_SLOWLOG_SSH="${REDIS_SLOWLOG_SSH:-}"
REMOTE_ENV_PATH="${REDIS_SLOWLOG_ENV_PATH:-/opt/chatapp/shared/.env}"

if ! [[ "${SLOWLOG_N}" =~ ^[0-9]+$ ]]; then
  echo "SLOWLOG_N must be non-negative digits only" >&2
  exit 2
fi

if [[ -n "$REDIS_SLOWLOG_SSH" ]]; then
  echo "=== Redis SLOWLOG via SSH ${REDIS_SLOWLOG_SSH} (n=${SLOWLOG_N}, ENV_PATH=${REMOTE_ENV_PATH}) ==="
  # Quoted remote command so the local shell never injects ENV_PATH from the laptop into the VM.
  exec ssh -o BatchMode=yes -o ConnectTimeout=15 "$REDIS_SLOWLOG_SSH" \
    "ENV_PATH=${REMOTE_ENV_PATH} exec python3 /opt/chatapp-monitoring/redis_exporter_redis_url.py slowlog ${SLOWLOG_N}"
fi

echo "=== Redis SLOWLOG (local) ==="
if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli not found. Install redis-tools or use REDIS_SLOWLOG_SSH=ubuntu@<app-vm>." >&2
  exit 1
fi

PY="${CHATAPP_REPO_ROOT}/deploy/redis_exporter_redis_url.py"
if [[ -n "${REDIS_URL:-}" ]]; then
  exec env REDIS_URL="${REDIS_URL}" python3 "$PY" slowlog "${SLOWLOG_N}"
fi

exec env ENV_PATH="${ENV_PATH:-/opt/chatapp/shared/.env}" python3 "$PY" slowlog "${SLOWLOG_N}"
