#!/usr/bin/env bash
# Fan-out multiplier baseline — run against Prometheus after a load test or steady traffic.
# Requires PROMETHEUS_URL (see docs/operations-monitoring.md).
set -euo pipefail
BASE="${PROMETHEUS_URL:?Set PROMETHEUS_URL}"

query() {
  local label="$1"
  local promql="$2"
  echo "=== ${label} ==="
  curl -fsS -G "${BASE}/api/v1/query" --data-urlencode "query=${promql}" | head -c 1200
  echo
}

query "Fanout target-cache rate (last 5m)" \
  'sum by (path, result) (rate(fanout_target_cache_total[5m]))'

query "Realtime fanout stage p95 (last 5m)" \
  'histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket[5m])))'

query "Realtime fanout targets p95 (last 5m)" \
  'histogram_quantile(0.95, sum by (le, path) (rate(fanout_publish_targets_bucket[5m])))'

query "Realtime fanout publish failures (last 5m)" \
  'sum by (channel_prefix) (rate(redis_fanout_publish_failures_total[5m]))'

query "WS bootstrap wall p95 (last 5m)" \
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket[5m])))'

query "WS bootstrap channels p95 (last 5m)" \
  'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket[5m])))'

query "WS bootstrap list-cache rate (last 5m)" \
  'sum by (result) (rate(ws_bootstrap_list_cache_total[5m]))'

echo
echo "=== presence_fanout_recipients (histogram — export quantiles in Grafana) ==="
echo "Use: histogram_quantile(0.95, sum(rate(presence_fanout_recipients_bucket[5m])) by (le, channel_type))"
echo "=== Message ingest stream (if enabled) ==="
curl -fsS -G "${BASE}/api/v1/query" --data-urlencode 'query=rate(message_ingest_stream_appended_total[5m])' 2>/dev/null | head -c 400 || echo "(no data — MESSAGE_INGEST_STREAM_ENABLED may be off)"
echo
