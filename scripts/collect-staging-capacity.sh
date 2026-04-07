#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <output-file> [ssh-host]" >&2
  exit 1
fi

OUTPUT_FILE="$1"
SSH_HOST="${2:-${STAGING_SSH_HOST:-ssperrottet@136.114.103.71}}"
PROM_URL="${PROM_URL:-http://127.0.0.1:9090}"

mkdir -p "$(dirname "$OUTPUT_FILE")"

python3 - "$OUTPUT_FILE" "$SSH_HOST" "$PROM_URL" <<'PY'
import json
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

output_file, ssh_host, prom_url = sys.argv[1:4]
queries = {
    "route_p95_top": 'sort_desc(histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m]))))',
    "five_xx_rate": 'sum(rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[5m]))',
    "five_xx_peak_rate": 'max_over_time(sum(rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[1m]))[12m:30s])',
    "five_xx_by_route_peak": 'sort_desc(max_over_time(sum by (route) (rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[1m]))[12m:30s]))',
    "overload_shed_total": 'sum(http_overload_shed_total{job="chatapp-api"})',
    "overload_stage_max": 'max(chatapp_overload_stage{job="chatapp-api"})',
    "rss_mb": 'max(process_resident_memory_bytes{job="chatapp-api"}) / 1024 / 1024',
    # cpu_seconds_rate: instantaneous rate at snapshot time (post-run, reflects cooldown — not peak).
    # cpu_peak_rate: max 1-minute rate seen during the last 12 minutes — captures burst during the test.
    "cpu_seconds_rate": 'sum(rate(process_cpu_seconds_total{job="chatapp-api"}[2m]))',
    "cpu_peak_rate": 'max_over_time(sum(rate(process_cpu_seconds_total{job="chatapp-api"}[1m]))[12m:30s])',
    "cpu_by_instance": 'max_over_time(rate(process_cpu_seconds_total{job="chatapp-api"}[1m])[12m:30s])',
    "eventloop_p99_ms": 'max(nodejs_eventloop_lag_p99_seconds{job="chatapp-api"}) * 1000',
    "eventloop_peak_ms": 'max_over_time(max(nodejs_eventloop_lag_p99_seconds{job="chatapp-api"})[12m:30s]) * 1000',
    "side_effect_queue_depth": 'sum(side_effect_queue_depth{job="chatapp-api"}) by (queue)',
    "side_effect_queue_workers": 'sum(side_effect_queue_active_workers{job="chatapp-api"}) by (queue)',
    "presence_fanout_rate": 'sum by (status, throttled) (rate(presence_fanout_total{job="chatapp-api"}[5m]))',
    "pg_pool_total": 'max_over_time(pg_pool_total{job="chatapp-api"}[10m])',
    "pg_pool_idle": 'min_over_time(pg_pool_idle{job="chatapp-api"}[10m])',
    "pg_pool_waiting": 'max_over_time(pg_pool_waiting{job="chatapp-api"}[10m])',
    "redis_memory_mb": 'redis_memory_used_bytes / 1024 / 1024',
    "redis_connected_clients": 'redis_connected_clients',
}

def run_query(name, query):
    encoded = urllib.parse.quote(query, safe='')
    cmd = [
        'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=no',
        ssh_host,
        f"curl -fsS '{prom_url}/api/v1/query?query={encoded}'",
    ]
    try:
        output = subprocess.check_output(cmd, text=True)
        return json.loads(output)
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": str(exc)}

payload = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "sshHost": ssh_host,
    "prometheusUrl": prom_url,
    "queries": {name: run_query(name, query) for name, query in queries.items()},
}

with open(output_file, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)

print(f"wrote {output_file}")
PY
