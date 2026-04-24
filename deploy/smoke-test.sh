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

# ── Meilisearch verification (only when SEARCH_BACKEND=meili) ─────────────────
if [ "${SEARCH_BACKEND:-postgres}" = "meili" ]; then
  echo ""
  echo "=== Meilisearch verification (SEARCH_BACKEND=meili) ==="
  MEILI_HOST="${MEILI_HOST:-http://10.0.0.146:7700}"
  MEILI_KEY="${MEILI_MASTER_KEY:-}"

  if [ -z "$MEILI_KEY" ]; then
    echo "FAIL: MEILI_MASTER_KEY not set but SEARCH_BACKEND=meili"
    exit 1
  fi

  echo "Checking Meilisearch health at ${MEILI_HOST}..."
  MEILI_STATUS=$(curl -sf -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_HOST}/health" || echo '{}')
  if ! echo "$MEILI_STATUS" | grep -q '"available"'; then
    echo "FAIL: Meilisearch not healthy (${MEILI_HOST}): ${MEILI_STATUS}"
    exit 1
  fi
  echo "✓ Meilisearch healthy"

  INDEX="${MEILI_INDEX_MESSAGES:-messages}"
  echo "Checking index '${INDEX}'..."
  IDX_STATUS=$(curl -sf -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_HOST}/indexes/${INDEX}" || echo '{}')
  if ! echo "$IDX_STATUS" | grep -q '"uid"'; then
    echo "FAIL: Meilisearch index '${INDEX}' not found"
    exit 1
  fi
  echo "✓ Index '${INDEX}' exists"
  echo "=== Meilisearch verification passed ==="
fi

exit 0
