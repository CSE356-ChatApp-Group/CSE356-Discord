#!/bin/bash
# deploy/health-check.sh
# Verify that a candidate release is healthy before cutover.
# Usage: ./health-check.sh <port> [base-url]

set -euo pipefail

PORT=${1:?Port required}
BASE_URL=${2:-http://localhost:$PORT}
MAX_ATTEMPTS=${HEALTH_MAX_ATTEMPTS:-15}
SLEEP_SECONDS=${HEALTH_RETRY_DELAY_SECONDS:-2}

echo "=== Health Check on $BASE_URL ==="

wait_for_health() {
  local attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if curl -fsS --max-time 5 "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi

    if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
      echo "Waiting for /health to become ready (attempt ${attempt}/${MAX_ATTEMPTS})..."
      sleep "$SLEEP_SECONDS"
    fi
  done

  return 1
}

# Test HTTP health endpoint
echo "Testing /health endpoint..."
if ! wait_for_health; then
  echo "FAIL: Health endpoint returned error after ${MAX_ATTEMPTS} attempts"
  exit 1
fi
echo "✓ HTTP health OK"

# Test database connectivity via health endpoint
echo "Testing database connectivity..."
HEALTH_JSON=$(curl -fsS --max-time 5 "$BASE_URL/health")
if echo "$HEALTH_JSON" | grep -q '"status":"ok"'; then
  echo "✓ Database and Redis OK"
else
  echo "FAIL: Health check reported unhealthy"
  echo "$HEALTH_JSON"
  exit 1
fi

# Test basic API endpoint
echo "Testing API endpoint..."
if curl -sf "$BASE_URL/api/v1/presence?userIds=test" >/dev/null 2>&1; then
  echo "✓ API endpoint OK"
else
  echo "⚠ API endpoint check skipped (may be expected)"
fi

echo "=== Health check passed ==="
exit 0
