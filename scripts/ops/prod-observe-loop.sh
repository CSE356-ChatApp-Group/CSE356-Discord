#!/usr/bin/env bash
# Periodically run prod-observe.sh for grader windows (POST /messages status mix + health).
#
# Usage:
#   INTERVAL_SEC=120 ./scripts/ops/prod-observe-loop.sh
#   INTERVAL_SEC=300 POST_MSG_MINUTES=30 ./scripts/ops/prod-observe-loop.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL_SEC="${INTERVAL_SEC:-120}"
export POST_MSG_MINUTES="${POST_MSG_MINUTES:-30}"

echo "Loop: prod-observe every ${INTERVAL_SEC}s (POST_MSG_MINUTES=${POST_MSG_MINUTES}). Ctrl+C to stop."
while true; do
  echo ""
  echo "======== $(date -u +%Y-%m-%dT%H:%M:%SZ) ========"
  "${SCRIPT_DIR}/prod-observe.sh" 2>&1 | head -n 35
  sleep "${INTERVAL_SEC}"
done
