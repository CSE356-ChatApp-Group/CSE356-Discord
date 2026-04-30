#!/usr/bin/env bash
# Fetch a small set of instant queries from Prometheus for outage/latency triage.
# Run from any host that can reach Prometheus (or via SSH -L 9090:127.0.0.1:9090 ...).
#
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/metrics-snapshot.sh
#   ./scripts/metrics/metrics-snapshot.sh --write var/metrics-snapshot.txt
#
# Range window for rate()/histogram_quantile (default 5m; use 10m for stability audits):
#   METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL=... ./scripts/metrics/metrics-snapshot.sh
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"

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
  'sum(up{job="chatapp-api"})'
  'count(up{job="chatapp-api"})'
  'max(chatapp_overload_stage{job="chatapp-api"})'
  'max(pg_pool_waiting{job="chatapp-api"})'
  'max(pg_pool_idle{job="chatapp-api"})'
  'sum(rate(http_overload_shed_total{job="chatapp-api"}[5m]))'
  'sum(rate(abuse_auto_ban_blocks_total{job="chatapp-api"}[5m]))'
  'sum(rate(abuse_auto_ban_issued_total{job="chatapp-api"}[5m]))'
  'sum(rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[5m]))'
  'sum(rate(pg_pool_operation_errors_total{job="chatapp-api"}[5m])) by (reason)'
  'histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'sum by (route) (rate(http_server_requests_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, route) (rate(pg_business_sql_queries_per_http_request_bucket{job="chatapp-api"}[5m])))'
  'sum(rate(redis_fanout_publish_failures_total{job="chatapp-api"}[5m]))'
  'sum by (path, result) (rate(fanout_target_cache_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le, path) (rate(fanout_publish_targets_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le, path) (rate(fanout_target_candidates_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le, path) (rate(fanout_job_latency_ms_bucket{job="chatapp-api",result="success"}[5m])))'
  'histogram_quantile(0.99, sum by (le, path) (rate(fanout_job_latency_ms_bucket{job="chatapp-api",result="success"}[5m])))'
  'max by (queue) (fanout_queue_depth{job="chatapp-api"})'
  'sum by (path) (rate(fanout_retry_total{job="chatapp-api"}[5m]))'
  'sum by (phase) (rate(delivery_timeout_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket{job="chatapp-api"}[5m])))'
  'sum by (result) (rate(ws_bootstrap_list_cache_total{job="chatapp-api"}[5m]))'
  'sum(rate(endpoint_list_cache_total{job="chatapp-api"}[5m])) by (endpoint, result)'
  'sum by (outcome) (rate(message_post_idempotency_poll_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, outcome) (rate(message_post_idempotency_poll_wait_ms_bucket{job="chatapp-api"}[5m])))'
  # Read-receipt insert-lock shedding + POST/read SLO helpers (canary gates)
  'sum by (vm) (rate(read_receipt_shed_total{job="chatapp-api",reason="message_channel_insert_lock_pressure"}[5m]))'
  'sum by (vm, status_code) (rate(message_post_response_total{job="chatapp-api"}[5m]))'
  'sum by (vm, status_class) (rate(http_server_requests_total{job="chatapp-api",method="PUT",route="/api/v1/messages/:id/read"}[5m]))'
  'sum by (vm, result) (rate(message_channel_insert_lock_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[5m])))'
  'histogram_quantile(0.99, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[5m])))'
  'histogram_quantile(0.95, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[5m])))'
  'histogram_quantile(0.99, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[5m])))'
  'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",route!="/metrics"}[5m])))'
  'histogram_quantile(0.95, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.99, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}[5m])))'
  '100 * sum(rate(node_cpu_seconds_total{job="db-node",mode="iowait"}[5m])) / clamp_min(sum(rate(node_cpu_seconds_total{job="db-node"}[5m])), 1e-9)'
  '100 * (1 - sum(rate(node_cpu_seconds_total{job="db-node",mode="idle"}[5m])) / clamp_min(sum(rate(node_cpu_seconds_total{job="db-node"}[5m])), 1e-9))'
  'max by (vm, instance) (message_channel_insert_lock_pressure_recent_timeout_count{job="chatapp-api"})'
  'max by (vm, instance) (message_channel_insert_lock_pressure_wait_p95_ms{job="chatapp-api"})'
  # Redis (redis_exporter job=redis on PROM_REDIS_HOST:9121)
  'redis_up{job="redis"}'
  'max(redis_memory_used_bytes{job="redis"})'
  'max(redis_memory_max_bytes{job="redis"})'
  'sum(rate(redis_evicted_keys_total{job="redis"}[5m]))'
  'sum(rate(redis_commands_processed_total{job="redis"}[5m]))'
  'sum(rate(redis_acl_access_denied_cmd_total{job="redis"}[5m])) + sum(rate(redis_acl_access_denied_key_total{job="redis"}[5m])) + sum(rate(redis_acl_access_denied_channel_total{job="redis"}[5m]))'
  # WS reliable delivery: realtime_success_rate, replay_fallback_rate, tail latency by path
  '100 * sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="realtime"}[5m])) / clamp_min(sum(rate(ws_reliable_delivery_total{job="chatapp-api"}[5m])), 1e-9)'
  '100 * sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="replay"}[5m])) / clamp_min(sum(rate(ws_reliable_delivery_total{job="chatapp-api"}[5m])), 1e-9)'
  'sum by (path, source) (rate(ws_reliable_delivery_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le, path) (rate(ws_reliable_delivery_latency_ms_bucket{job="chatapp-api"}[5m])))'
  'sum(rate(ws_reconnects_total{job="chatapp-api"}[5m]))'
  'sum by (reason) (rate(realtime_miss_attribution_total{job="chatapp-api"}[5m]))'
  'sum by (segment) (rate(channel_message_fanout_recipient_total{job="chatapp-api"}[5m]))'
  'sum by (result) (rate(message_post_fanout_job_total{job="chatapp-api"}[5m]))'
  'sum by (class) (rate(pending_replay_recipient_total{job="chatapp-api"}[5m]))'
  'sum by (mode) (rate(pending_replay_second_probe_recent_user_total{job="chatapp-api"}[5m]))'
  'sum by (reason) (rate(ws_replay_fail_open_total{job="chatapp-api"}[5m]))'
  'sum by (path, topic_prefix) (rate(ws_reliable_delivery_topic_total{job="chatapp-api"}[5m]))'
  'sum by (topic_prefix) (rate(ws_reliable_delivery_topic_total{job="chatapp-api",path="replay"}[5m]))'
  'sum(rate(offline_pending_skipped_total{job="chatapp-api"}[5m]))'
  'histogram_quantile(0.95, sum by (le) (rate(pending_replay_entries_per_message_bucket{job="chatapp-api"}[5m])))'
  'histogram_quantile(0.95, sum by (le) (rate(ws_pending_user_zset_size_bucket{job="chatapp-api"}[5m])))'
)

run() {
  echo "=== ChatApp metrics snapshot ==="
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

  if [[ -n "${REDIS_SLOWLOG_SSH:-}" ]]; then
    echo "--- redis SLOWLOG (REDIS_SLOWLOG_SSH=${REDIS_SLOWLOG_SSH}) ---"
    if ! REDIS_SLOWLOG_SSH="${REDIS_SLOWLOG_SSH}" bash "${CHATAPP_REPO_ROOT}/scripts/redis/redis-slowlog-snapshot.sh"; then
      echo '{"status":"error","error":"redis SLOWLOG snapshot failed"}'
    fi
    echo ""
  fi
}

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  run | tee "$OUT"
  echo "Wrote $OUT"
else
  run
fi
