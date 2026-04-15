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
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import datetime, timezone

output_file, ssh_host, prom_url = sys.argv[1:4]

# One new TCP connection per Prometheus query (×2 snapshots per load test) can trigger
# sshd MaxStartups / fail2ban / rate limits ("Connection reset" during kex). Reuse one
# connection via OpenSSH multiplexing for all queries in this process.
_ssh_dir = os.path.expanduser('~/.ssh')
os.makedirs(_ssh_dir, mode=0o700, exist_ok=True)
_ssh_sock = os.path.join(
    _ssh_dir,
    'cm-chatapp-prom-' + hashlib.sha256(ssh_host.encode()).hexdigest()[:20],
)
_ssh_base = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'ControlMaster=auto',
    '-o',
    f'ControlPath={_ssh_sock}',
    '-o',
    'ControlPersist=120',
]

def _ssh_mux_teardown():
    subprocess.run(
        ['ssh', *_ssh_base, '-O', 'exit', ssh_host],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5,
    )

queries = {
    "route_p95_top": 'sort_desc(histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m]))))',
    "business_sql_p95_top": 'sort_desc(histogram_quantile(0.95, sum by (le, route) (rate(pg_business_sql_queries_per_http_request_bucket{job="chatapp-api"}[5m]))))',
    "five_xx_rate": 'sum(rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[5m]))',
    "five_xx_peak_rate": 'max_over_time(sum(rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[1m]))[12m:30s])',
    "five_xx_by_route_peak": 'sort_desc(max_over_time(sum by (route) (rate(http_server_requests_total{job="chatapp-api",status_class="5xx"}[1m]))[12m:30s]))',
    # Cumulative counters over a window — survives post-burst instant queries where rate()≈0.
    "five_xx_increase_15m": 'sum(increase(http_server_requests_total{job="chatapp-api",status_class="5xx"}[15m]))',
    "five_xx_increase_by_route_15m": 'sort_desc(topk(12, sum by (route) (increase(http_server_requests_total{job="chatapp-api",status_class="5xx"}[15m]))))',
    "http_aborted_increase_15m": 'sum(increase(http_server_requests_aborted_total{job="chatapp-api"}[15m]))',
    "http_aborted_increase_by_route_15m": 'sort_desc(topk(12, sum by (route) (increase(http_server_requests_aborted_total{job="chatapp-api"}[15m]))))',
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
    "fanout_target_cache_rate": 'sum by (path, result) (rate(fanout_target_cache_total{job="chatapp-api"}[5m]))',
    "fanout_stage_p95": 'histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))',
    "fanout_targets_p95": 'histogram_quantile(0.95, sum by (le, path) (rate(fanout_publish_targets_bucket{job="chatapp-api"}[5m])))',
    "redis_fanout_publish_failures_rate": 'sum by (channel_prefix) (rate(redis_fanout_publish_failures_total{job="chatapp-api"}[5m]))',
    "message_post_by_status": 'sum by (status_code) (rate(message_post_response_total{job="chatapp-api"}[5m]))',
    "ws_connection_by_result": 'sum by (result) (rate(ws_connection_result_total{job="chatapp-api"}[5m]))',
    "ws_backpressure_rate": 'sum(rate(ws_backpressure_events_total{job="chatapp-api"}[5m])) by (action)',
    "ws_bootstrap_wall_p95": 'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket{job="chatapp-api"}[5m])))',
    "ws_bootstrap_channels_p95": 'histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket{job="chatapp-api"}[5m])))',
    "ws_bootstrap_list_cache_rate": 'sum by (result) (rate(ws_bootstrap_list_cache_total{job="chatapp-api"}[5m]))',
    "presence_fanout_rate": 'sum by (status, throttled) (rate(presence_fanout_total{job="chatapp-api"}[5m]))',
    "pg_pool_total": 'max_over_time(pg_pool_total{job="chatapp-api"}[10m])',
    "pg_pool_idle": 'min_over_time(pg_pool_idle{job="chatapp-api"}[10m])',
    "pg_pool_waiting": 'max_over_time(pg_pool_waiting{job="chatapp-api"}[10m])',
    # Fallback if job label or scrape differs on a given host
    "pg_pool_total_any": 'max(max_over_time(pg_pool_total[10m]))',
    "pg_pool_idle_any": 'min(min_over_time(pg_pool_idle[10m]))',
    "pg_pool_waiting_any": 'max(max_over_time(pg_pool_waiting[10m]))',
    # Any redis_exporter job/instance (staging Prometheus may not use job="redis").
    "redis_memory_mb": 'max(max by (job, instance) (redis_memory_used_bytes)) / 1024 / 1024',
    "redis_connected_clients": 'max(max by (job, instance) (redis_connected_clients))',
}

def run_query(name, query, retries=2):
    encoded = urllib.parse.quote(query, safe='')
    cmd = [
        'ssh',
        *_ssh_base,
        ssh_host,
        f"curl -fsS --connect-timeout 8 --max-time 25 '{prom_url}/api/v1/query?query={encoded}'",
    ]
    last_err = None
    for attempt in range(retries + 1):
        try:
            output = subprocess.check_output(cmd, text=True)
            return json.loads(output)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries:
                time.sleep(0.4 * (attempt + 1))
    return {"status": "error", "error": str(last_err)}

payload = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "sshHost": ssh_host,
    "prometheusUrl": prom_url,
    "queries": {},
}
try:
    for qname, qexpr in queries.items():
        payload['queries'][qname] = run_query(qname, qexpr)
        # Tiny gap so multiplexed sessions are not confused with flood traffic on fragile hosts.
        time.sleep(0.02)
finally:
    _ssh_mux_teardown()

with open(output_file, 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)

print(f"wrote {output_file}")
PY
