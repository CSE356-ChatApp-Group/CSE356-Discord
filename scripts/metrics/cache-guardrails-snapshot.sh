#!/usr/bin/env bash
# Focused cache guardrails snapshot for staged cache rollouts.
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/cache-guardrails-snapshot.sh
#   METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/cache-guardrails-snapshot.sh --write var/cache-guardrails.txt

set -euo pipefail

BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
BASE="${BASE%/}"
RANGE="${METRICS_SNAPSHOT_RANGE:-5m}"
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
  'sum by (endpoint, result) (rate(endpoint_list_cache_total{job="chatapp-api"}[5m]))'
  'sum by (endpoint) (rate(endpoint_list_cache_total{job="chatapp-api",result="hit"}[5m])) / clamp_min(sum by (endpoint) (rate(endpoint_list_cache_total{job="chatapp-api"}[5m])), 1e-9)'
  'sum by (scope, reason) (rate(message_list_cache_store_skipped_total{job="chatapp-api"}[5m]))'
  'sum by (path) (rate(messages_list_access_cache_hit_total{job="chatapp-api"}[5m]))'
  'sum by (result) (rate(ws_bootstrap_list_cache_total{job="chatapp-api"}[5m]))'
  'sum by (path, result) (rate(fanout_target_cache_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",route!="/metrics"}[5m])))'
  'max(pg_pool_waiting{job="chatapp-api"})'
  'sum(rate(pg_pool_operation_errors_total{job="chatapp-api"}[5m])) by (reason)'
  'sum(rate(redis_evicted_keys_total{job="redis"}[5m]))'
  'max(redis_memory_used_bytes{job="redis"}) / clamp_min(max(redis_memory_max_bytes{job="redis"}), 1)'
)

run() {
  echo "=== ChatApp cache guardrails snapshot ==="
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
}

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  run | tee "$OUT"
  echo "Wrote $OUT"
else
  run
fi
