#!/usr/bin/env bash
# Quick canary gate snapshot for read-route strain tuning.
# Focus: read-route shed effectiveness + message-post safety.
#
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/read-receipt-strain-gates.sh
#   METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/read-receipt-strain-gates.sh
set -euo pipefail

BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
BASE="${BASE%/}"
RANGE="${METRICS_SNAPSHOT_RANGE:-5m}"

queries=(
  'sum by (vm, reason) (rate(read_receipt_shed_total{job="chatapp-api"}[5m]))'
  'sum by (vm, result) (rate(read_receipt_requests_total{job="chatapp-api"}[5m]))'
  'sum by (vm, result) (rate(read_receipt_preflight_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, vm, phase, result) (rate(read_receipt_phase_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="PUT",route="/api/v1/messages/:id/read"}[5m])))'
  'histogram_quantile(0.99, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="PUT",route="/api/v1/messages/:id/read"}[5m])))'
  'max by (vm) (pg_pool_waiting{job="chatapp-api"})'
  'sum by (vm) (rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[5m]))'
  'sum by (vm, status_code) (rate(message_post_response_total{job="chatapp-api"}[5m]))'
)

echo "=== Read route strain gates ==="
echo "PROMETHEUS_URL=${BASE}"
echo "METRICS_SNAPSHOT_RANGE=${RANGE}"
echo "time_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

for q in "${queries[@]}"; do
  q="${q//\[5m\]/[${RANGE}]}"
  echo "--- query: ${q}"
  enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$q")
  if ! curl -fsS "${BASE}/api/v1/query?query=${enc}"; then
    echo '{"status":"error","error":"curl failed"}'
  fi
  echo ""
done
