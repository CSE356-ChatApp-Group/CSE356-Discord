#!/usr/bin/env bash
# Fan-out multiplier baseline — run against Prometheus after a load test or steady traffic.
# Requires PROMETHEUS_URL (see docs/operations-monitoring.md).
set -euo pipefail
BASE="${PROMETHEUS_URL:?Set PROMETHEUS_URL}"
echo "=== Redis fanout publish rate (last 5m) ==="
curl -fsS -G "${BASE}/api/v1/query" --data-urlencode 'query=sum(rate(redis_fanout_publish_failures_total[5m]))' | head -c 800
echo
echo "=== presence_fanout_recipients (histogram — export quantiles in Grafana) ==="
echo "Use: histogram_quantile(0.95, sum(rate(presence_fanout_recipients_bucket[5m])) by (le, channel_type))"
echo "=== Message ingest stream (if enabled) ==="
curl -fsS -G "${BASE}/api/v1/query" --data-urlencode 'query=rate(message_ingest_stream_appended_total[5m])' 2>/dev/null | head -c 400 || echo "(no data — MESSAGE_INGEST_STREAM_ENABLED may be off)"
echo
