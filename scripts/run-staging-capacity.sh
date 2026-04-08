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

# Optional: fill metadata from staging /opt/chatapp/shared/.env (needs SSH). Default off
# so local runs without keys are not delayed. Enable: FETCH_STAGING_REMOTE_ENV=1
if [[ "${FETCH_STAGING_REMOTE_ENV:-0}" == "1" ]]; then
  _remote_env="$(
    ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no "$SSH_HOST" \
      "grep -E '^(OVERLOAD_HTTP_SHED_ENABLED|OVERLOAD_LAG_SHED_MS|POOL_CIRCUIT_BREAKER_QUEUE)=' /opt/chatapp/shared/.env 2>/dev/null" \
      || true
  )"
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    case "$line" in
      OVERLOAD_HTTP_SHED_ENABLED=*) SHED_ENABLED="${line#*=}" ;;
      OVERLOAD_LAG_SHED_MS=*) SHED_LAG_MS="${line#*=}" ;;
      POOL_CIRCUIT_BREAKER_QUEUE=*) POOL_QUEUE="${line#*=}" ;;
    esac
  done <<< "${_remote_env}"
fi

mkdir -p "$RUN_DIR"
RUN_START_EPOCH="$(date -u +%s)"

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
echo "KPI regression gate:  npm run load:staging:slo   (optimization_* counters + fixed rate)"
echo "Fast iteration:      npm run load:staging:tune"
echo "Stress envelope:     npm run load:staging:break / load:staging:break-fast"
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
  -e LOADTEST_HTTP_TIMEOUT_MS="${LOADTEST_HTTP_TIMEOUT_MS:-}" \
  "$K6_IMAGE" run \
    --summary-export "/work/artifacts/load-tests/$RUN_ID/summary.json" \
    --out "json=/work/artifacts/load-tests/$RUN_ID/metrics.ndjson" \
    /work/load-tests/staging-capacity.js
K6_EXIT=$?
set -e

{
  echo "k6_exit=$K6_EXIT"
  echo "git_sha_full=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$RUN_DIR/metadata.txt"

echo "[3/4] Capturing post-run Prometheus snapshot..."
if ! "$ROOT_DIR/scripts/collect-staging-capacity.sh" "$RUN_DIR/prometheus-after.json" "$SSH_HOST"; then
  echo "Warning: post-run snapshot failed" >&2
fi

echo "[3b/4] Capturing app logs for run window..."
if ! ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$SSH_HOST" \
  "sudo journalctl --since '@$RUN_START_EPOCH' -u chatapp@4000 -u chatapp@4001 --no-pager -o cat" \
  > "$RUN_DIR/app.log"; then
  echo "Warning: app log capture failed" >&2
fi

if command -v rg >/dev/null 2>&1 && [[ -s "$RUN_DIR/app.log" ]]; then
  rg -N "Unhandled error|POOL_CIRCUIT_OPEN|PoolTimeoutError|timeout exceeded|too many clients|statement timeout|query_canceled" \
    "$RUN_DIR/app.log" > "$RUN_DIR/app-errors.log" || true
fi

echo "[4/4] Rendering report..."
if node "$ROOT_DIR/scripts/render-capacity-report.mjs" "$RUN_DIR" "$K6_EXIT" > "$RUN_DIR/report.md"; then
  cat "$RUN_DIR/report.md"
else
  echo "Warning: report generation failed" >&2
fi

if [[ "$PROFILE" == "slo" ]]; then
  echo
  echo "[gate] Validating SLO go-live gates..."
  if ! node "$ROOT_DIR/scripts/validate-capacity-gates.mjs" "$RUN_DIR" "$PROFILE"; then
    K6_EXIT=1
  fi
fi

echo
echo "Artifacts saved to $RUN_DIR"
echo "k6 exit code: $K6_EXIT"
exit $K6_EXIT
