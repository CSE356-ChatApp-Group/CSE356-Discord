#!/usr/bin/env bash
# Fetch a small set of instant queries from Prometheus for outage/latency triage.
# Run from any host that can reach Prometheus (or via SSH -L 9090:127.0.0.1:9090 ...).
#
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics-snapshot.sh
#   ./scripts/metrics-snapshot.sh --write var/metrics-snapshot.txt
set -euo pipefail

BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
BASE="${BASE%/}"
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write)
      OUT="${2:?}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

queries=(
  'max(up{job="chatapp-api"})'
  'max(chatapp_overload_stage{job="chatapp-api"})'
  'max(pg_pool_waiting{job="chatapp-api"})'
  'max(pg_pool_idle{job="chatapp-api"})'
  'sum(rate(http_overload_shed_total{job="chatapp-api"}[5m]))'
  'sum(rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[5m]))'
  'sum(rate(pg_pool_operation_errors_total{job="chatapp-api"}[5m])) by (reason)'
  'histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'sum by (route) (rate(http_server_requests_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, route) (rate(pg_business_sql_queries_per_http_request_bucket{job="chatapp-api"}[5m])))'
  'sum(rate(redis_fanout_publish_failures_total{job="chatapp-api"}[5m]))'
  'sum by (path, result) (rate(fanout_target_cache_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le, path) (rate(fanout_publish_targets_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket{job="chatapp-api"}[5m])))'
  'sum by (result) (rate(ws_bootstrap_list_cache_total{job="chatapp-api"}[5m]))'
  'sum(rate(endpoint_list_cache_total{job="chatapp-api"}[5m])) by (endpoint, result)'
)

run() {
  echo "=== ChatApp metrics snapshot ==="
  echo "PROMETHEUS_URL=${BASE}"
  echo "time_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""

  for q in "${queries[@]}"; do
    echo "--- query: ${q}"
    enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$q")
    if ! curl -fsS "${BASE}/api/v1/query?query=${enc}"; then
      echo '{"status":"error","error":"curl failed"}'
    fi
    echo ""
  done
}

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  run | tee "$OUT"
  echo "Wrote $OUT"
else
  run
fi
