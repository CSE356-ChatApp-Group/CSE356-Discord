#!/usr/bin/env bash
# run-200msg-sec.sh — Run the dedicated POST /messages capacity benchmark.
#
# Prerequisites:
#   1. Staging deployed with rate-limit bypass (deploy-staging.sh handles this
#      via staging.required.env + nginx staging.conf).
#   2. k6 available via Docker (uses grafana/k6 image).
#
# Usage:
#   ./scripts/load/run-200msg-sec.sh smoke        # 10 msg/s × 1 min — validates bypass
#   ./scripts/load/run-200msg-sec.sh benchmark    # 200 msg/s × 10 min — full capacity
#   ./scripts/load/run-200msg-sec.sh ramp         # 50→300 staircase — find the cliff
#
# Options (env vars):
#   BASE_URL          — staging API URL (default: http://136.114.103.71/api/v1)
#   WS_URL            — staging WS URL (default: ws://136.114.103.71/ws)
#   NUM_SENDERS       — distinct sender accounts (default: 40)
#   NUM_CHANNELS      — target channels (default: 5)
#   LOADTEST_ENABLE_READ_RECEIPTS — set to 1 to include read-receipt traffic
#   LOADTEST_WS_MESSAGE_DELIVERY_PROBE — set to 1 to measure WS delivery latency
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"

PROFILE="${1:-${LOAD_PROFILE:-smoke}}"
ROOT_DIR="${CHATAPP_REPO_ROOT}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-msgcap-${PROFILE}}"
RUN_DIR="$ROOT_DIR/artifacts/load-tests/$RUN_ID"
SSH_HOST="${STAGING_SSH_HOST:-ssperrottet@136.114.103.71}"
BASE_URL="${BASE_URL:-http://136.114.103.71/api/v1}"
WS_URL="${WS_URL:-ws://136.114.103.71/ws}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.49.0}"
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

mkdir -p "$RUN_DIR"

cat > "$RUN_DIR/metadata.txt" <<EOF
run_id=$RUN_ID
profile=$PROFILE
type=message_capacity
git_sha=$GIT_SHA
base_url=$BASE_URL
ws_url=$WS_URL
num_senders=${NUM_SENDERS:-40}
num_channels=${NUM_CHANNELS:-5}
read_receipts=${LOADTEST_ENABLE_READ_RECEIPTS:-0}
ws_delivery_probe=${LOADTEST_WS_MESSAGE_DELIVERY_PROBE:-0}
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "=== POST /messages capacity benchmark ==="
echo "Profile:    $PROFILE"
echo "Run ID:     $RUN_ID"
echo "Base URL:   $BASE_URL"
echo "WS URL:     $WS_URL"
echo "Senders:    ${NUM_SENDERS:-40}"
echo "Channels:   ${NUM_CHANNELS:-5}"
echo "Artifacts:  $RUN_DIR"
echo

echo "[1/4] Capturing baseline Prometheus snapshot..."
if ! "$ROOT_DIR/scripts/load/collect-staging-capacity.sh" "$RUN_DIR/prometheus-before.json" "$SSH_HOST"; then
  echo "Warning: baseline snapshot failed; continuing anyway" >&2
fi

RUN_START_EPOCH="$(date -u +%s)"

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
  -e NUM_SENDERS="${NUM_SENDERS:-40}" \
  -e NUM_CHANNELS="${NUM_CHANNELS:-5}" \
  -e LOADTEST_ENABLE_READ_RECEIPTS="${LOADTEST_ENABLE_READ_RECEIPTS:-0}" \
  -e LOADTEST_WS_MESSAGE_DELIVERY_PROBE="${LOADTEST_WS_MESSAGE_DELIVERY_PROBE:-0}" \
  "$K6_IMAGE" run \
    --summary-export "/work/artifacts/load-tests/$RUN_ID/summary.json" \
    --out "json=/work/artifacts/load-tests/$RUN_ID/metrics.ndjson" \
    /work/load-tests/staging-200msg-sec.js
K6_EXIT=$?
set -e

{
  echo "k6_exit=$K6_EXIT"
  echo "git_sha_full=$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$RUN_DIR/metadata.txt"

echo "[3/4] Capturing post-run Prometheus snapshot..."
if ! "$ROOT_DIR/scripts/load/collect-staging-capacity.sh" "$RUN_DIR/prometheus-after.json" "$SSH_HOST"; then
  echo "Warning: post-run snapshot failed" >&2
fi

echo "[3b/4] Capturing app logs..."
if ! ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$SSH_HOST" \
  "sudo journalctl --since '@$RUN_START_EPOCH' -u chatapp@4000 -u chatapp@4001 --no-pager -o cat" \
  > "$RUN_DIR/app.log"; then
  echo "Warning: app log capture failed" >&2
fi

echo "[4/4] Extracting key results from summary..."
if [[ -f "$RUN_DIR/summary.json" ]]; then
  echo
  echo "── Key Results ──"
  # Extract the most important metrics from k6 summary
  node -e "
    const s = require('$RUN_DIR/summary.json');
    const m = s.metrics || {};
    const post201 = m.message_post_201_total?.values?.count || 0;
    const postFail = m.message_post_fail_total?.values?.count || 0;
    const total = post201 + postFail;
    const postDur = m.message_post_duration?.values || {};
    const ws4xx = m.http_res_status_4xx_total?.values?.count || 0;
    const ws5xx = m.http_res_status_5xx_other_total?.values?.count || 0;
    const ws0 = m.http_res_status_0_total?.values?.count || 0;
    const deliveryMiss = m.ws_delivery_miss_total?.values?.count || 0;
    const deliveryMs = m.ws_delivery_after_post_ms?.values || {};
    console.log('  POST /messages total:   ' + total);
    console.log('  201 successes:          ' + post201 + ' (' + (total ? (post201/total*100).toFixed(1) : 0) + '%)');
    console.log('  Failures:               ' + postFail);
    console.log('  4xx (should be ~0):     ' + ws4xx);
    console.log('  5xx:                    ' + ws5xx);
    console.log('  Timeouts (status 0):    ' + ws0);
    console.log('  POST p50:               ' + (postDur['p(50)']?.toFixed(0) || '?') + 'ms');
    console.log('  POST p95:               ' + (postDur['p(95)']?.toFixed(0) || '?') + 'ms');
    console.log('  POST p99:               ' + (postDur['p(99)']?.toFixed(0) || '?') + 'ms');
    if (deliveryMs.count > 0) {
      console.log('  WS delivery p50:        ' + (deliveryMs['p(50)']?.toFixed(0) || '?') + 'ms');
      console.log('  WS delivery p95:        ' + (deliveryMs['p(95)']?.toFixed(0) || '?') + 'ms');
      console.log('  WS delivery misses:     ' + deliveryMiss);
    }
    const iterTotal = s.root_group?.groups?.[0]?.checks?.[0]?.passes || 0;
    const iterFail = s.root_group?.groups?.[0]?.checks?.[0]?.fails || 0;
    console.log('  Iteration duration:     ' + (m.iteration_duration?.values?.['p(95)']?.toFixed(0) || '?') + 'ms p95');
  " 2>/dev/null || echo "  (summary parse failed)"
  echo
fi

echo "Artifacts saved to $RUN_DIR"
echo "k6 exit code: $K6_EXIT"

if [[ "$PROFILE" == "smoke" ]]; then
  echo
  echo "Smoke test complete. If 4xx is near 0 and 201 rate is ~10/s:"
  echo "  → Bypass is working. Run: $0 benchmark"
  echo "  → Find the cliff:    $0 ramp"
fi

exit $K6_EXIT