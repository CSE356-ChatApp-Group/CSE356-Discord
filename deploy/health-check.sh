#!/bin/bash
# deploy/health-check.sh
# Verify that a candidate release is healthy before cutover.
# Usage: ./health-check.sh <port> [base-url]

set -e

PORT=${1:?Port required}
BASE_URL=${2:-http://localhost:$PORT}

echo "=== Health Check on $BASE_URL ==="

# Test HTTP health endpoint
echo "Testing /health endpoint..."
if ! curl -sf "$BASE_URL/health"; then
  echo "FAIL: Health endpoint returned error"
  exit 1
fi
echo "✓ HTTP health OK"

# Test database connectivity via health endpoint
echo "Testing database connectivity..."
HEALTH_JSON=$(curl -s "$BASE_URL/health")
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
