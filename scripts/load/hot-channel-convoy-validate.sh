#!/usr/bin/env bash
# Fetch Prometheus metrics relevant to hot-channel insert-lock convoy, after a
# sustained single-channel burst (see backend/scripts/bench-channel-hot-sustained.mjs).
#
# Usage:
#   1) Pick a quiet window; note start time.
#   2) Run burst (45–60s typical):
#        BASE_URL=... TOKEN=... CHANNEL_ID=... CONCURRENCY=8 DURATION_SEC=45 \
#          node backend/scripts/bench-channel-hot-sustained.mjs
#   3) Immediately run (WINDOW must cover the burst, e.g. 3m or 5m):
#        PROMETHEUS_URL=http://127.0.0.1:9090 METRICS_BURST_WINDOW=3m \
#          ./scripts/load/hot-channel-convoy-validate.sh
#
# Compare to historical failure pattern (pre-optimization convoy):
#   - insert lock wait p99 approaching MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS (~4000ms prod)
#   - holder p99 ~1000–1500ms+
#   - 503 spikes on POST /messages (insert lock wait timeout, waiter cap, recent shed)
#
# Interpretation (fill YES/NO after reading JSON):
#   convoy eliminated: wait p99 well under timeout AND low timeout counter AND low 503 rate
#   retries amplify: correlate client 503 with message_insert_lock_wait_timeout_total
set -euo pipefail

BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
BASE="${BASE%/}"
W="${METRICS_BURST_WINDOW:-3m}"

enc() {
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

qry() {
  local q="$1"
  echo "--- $q"
  curl -fsS "${BASE}/api/v1/query?query=$(enc "$q")" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get("data",{}).get("result",[]), indent=2)[:12000])'
  echo ""
}

echo "=== Hot-channel convoy validation (Prometheus instant) ==="
echo "PROMETHEUS_URL=${BASE}"
echo "METRICS_BURST_WINDOW=${W}"
echo "time_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

qry "histogram_quantile(0.95, sum by (le) (rate(message_channel_insert_lock_wait_ms_bucket{job=\"chatapp-api\",result=\"acquired\"}[${W}])))"
qry "histogram_quantile(0.99, sum by (le) (rate(message_channel_insert_lock_wait_ms_bucket{job=\"chatapp-api\",result=\"acquired\"}[${W}])))"

qry "histogram_quantile(0.95, sum by (le) (rate(message_insert_lock_holder_duration_ms_bucket{job=\"chatapp-api\"}[${W}])))"
qry "histogram_quantile(0.99, sum by (le) (rate(message_insert_lock_holder_duration_ms_bucket{job=\"chatapp-api\"}[${W}])))"

qry "histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_ms_bucket{job=\"chatapp-api\",method=\"POST\",route=\"/api/v1/messages/\"}[${W}])))"
qry "histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_ms_bucket{job=\"chatapp-api\",method=\"POST\",route=\"/api/v1/messages/\"}[${W}])))"

qry "sum(increase(message_post_response_total{job=\"chatapp-api\",status_code=\"503\"}[${W}]))"
qry "sum(increase(message_insert_lock_wait_timeout_total{job=\"chatapp-api\"}[${W}]))"
qry "sum(increase(message_insert_lock_queue_reject_total{job=\"chatapp-api\"}[${W}]))"
qry "sum by (result) (increase(message_channel_insert_lock_total{job=\"chatapp-api\"}[${W}]))"

qry "max(pg_pool_waiting{job=\"chatapp-api\"})"

qry "100 * sum(rate(node_cpu_seconds_total{job=\"db-node\",mode=\"iowait\"}[${W}])) / clamp_min(sum(rate(node_cpu_seconds_total{job=\"db-node\"}[${W}])), 1e-9)"
qry "100 * (1 - sum(rate(node_cpu_seconds_total{job=\"db-node\",mode=\"idle\"}[${W}])) / clamp_min(sum(rate(node_cpu_seconds_total{job=\"db-node\"}[${W}])), 1e-9))"

echo "=== Manual report (paste bench JSON + thresholds) ==="
echo "convoy eliminated: ___  (wait p99 << 4000ms AND timeout counter ~0 AND 503 ~0)"
echo "holder p99 reduced: ___  (vs ~1000–1500ms historical)"
echo "wait p99 reduced: ___  (vs ~4000ms timeout cliff)"
echo "503 under burst: ___  (sum 503 increase during WINDOW)"
echo "new per-channel throughput: ___ msgs/sec (from bench JSON throughput_201_per_sec)"
echo "remaining bottleneck: ___ (if pool/iowait high → Postgres; if holder high without wait → DB in lock; if wait high → lock convoy)"
