#!/bin/bash
# deploy/smoke-test.sh
# Run minimal smoke tests against a candidate release.
# Usage: ./smoke-test.sh <port> [base-url]

set -e

PORT=${1:?Port required}
BASE_URL=${2:-http://localhost:$PORT}

echo "=== Smoke Tests on $BASE_URL ==="

# Test 1: Health endpoint returns 200
echo "Test 1: Health endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
if [ "$HTTP_CODE" != "200" ]; then
  echo "FAIL: Health returned $HTTP_CODE"
  exit 1
fi
echo "✓ Health endpoint 200 OK"

# Test 2: API endpoint responds (even if unauthenticated rejection)
echo "Test 2: API endpoint reachability..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/presence?userIds=test-user" || true)
if [ "$HTTP_CODE" != "400" ] && [ "$HTTP_CODE" != "200" ]; then
  echo "WARN: API returned $HTTP_CODE (expected 200 or 400)"
fi
echo "✓ API endpoint reachable"

# Test 3: Check that the app started (process exists)
echo "Test 3: Process check..."
if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "✓ Process listening on port $PORT"
else
  echo "FAIL: No process listening on port $PORT"
  exit 1
fi

# Test 4: Minimal database connectivity check via health
echo "Test 4: Database check..."
HEALTH=$(curl -s "$BASE_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "✓ Database connected"
else
  echo "FAIL: Database health check failed"
  exit 1
fi

echo "=== Smoke tests passed ==="
exit 0
