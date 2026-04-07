#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-${LOAD_PROFILE:-break}}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}}"
RUN_DIR="$ROOT_DIR/artifacts/load-tests/$RUN_ID"
SSH_HOST="${STAGING_SSH_HOST:-ssperrottet@136.114.103.71}"
BASE_URL="${BASE_URL:-http://136.114.103.71/api/v1}"
WS_URL="${WS_URL:-ws://136.114.103.71/ws}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.49.0}"
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
SHED_ENABLED="${OVERLOAD_HTTP_SHED_ENABLED:-unset}"
SHED_LAG_MS="${OVERLOAD_LAG_SHED_MS:-unset}"
POOL_QUEUE="${POOL_CIRCUIT_BREAKER_QUEUE:-unset}"

mkdir -p "$RUN_DIR"

cat > "$RUN_DIR/metadata.txt" <<EOF
run_id=$RUN_ID
profile=$PROFILE
git_sha=$GIT_SHA
base_url=$BASE_URL
ws_url=$WS_URL
ssh_host=$SSH_HOST
overload_http_shed_enabled=$SHED_ENABLED
overload_lag_shed_ms=$SHED_LAG_MS
pool_circuit_breaker_queue=$POOL_QUEUE
message_size=${MESSAGE_SIZE:-96}
loadtest_password_set=$( [[ -n "${LOADTEST_PASSWORD:-}" ]] && echo true || echo false )
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "=== Staging capacity run ==="
echo "Profile:  $PROFILE"
echo "Run ID:   $RUN_ID"
echo "Base URL: $BASE_URL"
echo "WS URL:   $WS_URL"
echo "Artifacts: $RUN_DIR"
echo

echo "[1/4] Capturing baseline Prometheus snapshot..."
if ! "$ROOT_DIR/scripts/collect-staging-capacity.sh" "$RUN_DIR/prometheus-before.json" "$SSH_HOST"; then
  echo "Warning: baseline snapshot failed; continuing anyway" >&2
fi

echo "[2/4] Running k6 profile '$PROFILE'..."
set +e
docker run --rm \
  -v "$ROOT_DIR:/work" \
  -w /work \
  -e BASE_URL="$BASE_URL" \
  -e WS_URL="$WS_URL" \
  -e LOAD_PROFILE="$PROFILE" \
  -e RUN_ID="$RUN_ID" \
  -e LOADTEST_PASSWORD="${LOADTEST_PASSWORD:-LoadTest!12345}" \
  -e MESSAGE_SIZE="${MESSAGE_SIZE:-96}" \
  "$K6_IMAGE" run \
    --summary-export "/work/artifacts/load-tests/$RUN_ID/summary.json" \
    --out "json=/work/artifacts/load-tests/$RUN_ID/metrics.ndjson" \
    /work/load-tests/staging-capacity.js
K6_EXIT=$?
set -e

echo "[3/4] Capturing post-run Prometheus snapshot..."
if ! "$ROOT_DIR/scripts/collect-staging-capacity.sh" "$RUN_DIR/prometheus-after.json" "$SSH_HOST"; then
  echo "Warning: post-run snapshot failed" >&2
fi

echo "[4/4] Rendering report..."
if node "$ROOT_DIR/scripts/render-capacity-report.mjs" "$RUN_DIR" "$K6_EXIT" > "$RUN_DIR/report.md"; then
  cat "$RUN_DIR/report.md"
else
  echo "Warning: report generation failed" >&2
fi

echo
echo "Artifacts saved to $RUN_DIR"
echo "k6 exit code: $K6_EXIT"
exit $K6_EXIT
