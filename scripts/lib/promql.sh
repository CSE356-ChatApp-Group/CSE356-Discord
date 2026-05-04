#!/usr/bin/env bash
# scripts/lib/promql.sh
# Shared PromQL query helpers. Source this file; do not execute directly.
#
# Provides:
#   prom_query <query>                — raw JSON from Prometheus instant-query API
#   prom_scalar <query>               — max numeric value across all result vectors
#   prom_sum <query>                  — sum of all result values
#   prom_table <query>                — label=value pairs, one per line
#   prom_check_reachable              — exits 2 if Prometheus not reachable
#
# Configure via environment:
#   PROMETHEUS_URL  (default http://127.0.0.1:9090)
#   PROM_TIMEOUT    curl timeout seconds (default 8)

[[ "${_PROMQL_SH_LOADED:-}" == "1" ]] && return 0
_PROMQL_SH_LOADED=1

_PROM_BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
_PROM_BASE="${_PROM_BASE%/}"
_PROM_TIMEOUT="${PROM_TIMEOUT:-8}"

prom_query() {
  local q="$1"
  local enc
  enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$q")
  curl -fsS --max-time "${_PROM_TIMEOUT}" \
    "${_PROM_BASE}/api/v1/query?query=${enc}" 2>/dev/null \
    || echo '{"status":"error","data":{"resultType":"vector","result":[]}}'
}

# Returns max value across all result vectors, or empty string if no data.
prom_scalar() {
  prom_query "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="success": sys.exit(0)
vals=[float(r["value"][1]) for r in d.get("data",{}).get("result",[]) if r.get("value")]
if vals: print(max(vals))
' 2>/dev/null || true
}

# Returns sum of all result values, or empty string if no data.
prom_sum() {
  prom_query "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="success": sys.exit(0)
vals=[float(r["value"][1]) for r in d.get("data",{}).get("result",[]) if r.get("value")]
if vals: print(sum(vals))
' 2>/dev/null || true
}

# Returns "label1=v1 label2=v2  value" for each result vector.
prom_table() {
  prom_query "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="success": sys.exit(0)
for r in d.get("data",{}).get("result",[]):
  labels=" ".join(f"{k}={v}" for k,v in sorted(r.get("metric",{}).items()))
  val=r["value"][1] if r.get("value") else "?"
  print(f"{labels}  {val}")
' 2>/dev/null || true
}

prom_check_reachable() {
  if ! curl -fsS --max-time 5 "${_PROM_BASE}/-/healthy" >/dev/null 2>&1; then
    echo "ERROR: Cannot reach Prometheus at ${_PROM_BASE}" >&2
    exit 2
  fi
}

# Canonical query definitions. Import these into scripts to avoid drift.
# Usage: local q; q="${PROM_Q_5XX_RATE}"; q="${q//\$RANGE/$RANGE}"; prom_sum "$q"
# (where RANGE is your window, e.g. 5m)

# 5xx error rate (fraction)
PROM_Q_5XX_RATE='sum(rate(http_server_requests_total{job="chatapp-api",status_class="5xx",route!="/metrics"}[$RANGE])) / clamp_min(sum(rate(http_server_requests_total{job="chatapp-api",route!="/metrics"}[$RANGE])),1)'

# POST /messages p95 latency ms
PROM_Q_POST_P95='histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",route=~"/api/v1/messages/?",method="POST"}[$RANGE])))'

# DB pool waiting (max across workers)
PROM_Q_POOL_WAITING='max(pg_pool_waiting{job="chatapp-api"})'

# DB pool circuit breaker rejects/s
PROM_Q_CB_REJECTS='sum(rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[$RANGE]))'

# Fanout critical queue depth
PROM_Q_FANOUT_DEPTH='max(side_effect_queue_depth{job="chatapp-api",queue="fanout:critical"})'

# Fanout p95 queue delay ms
PROM_Q_FANOUT_DELAY_P95='histogram_quantile(0.95, sum by (le, queue) (rate(side_effect_queue_delay_ms_bucket{job="chatapp-api",queue="fanout:critical"}[$RANGE])))'

# WS bootstrap wall p95 ms
PROM_Q_WS_BOOTSTRAP_P95='histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket{job="chatapp-api"}[$RANGE])))'

# Event loop p99 lag seconds
PROM_Q_EVLOOP_P99='max(nodejs_eventloop_lag_p99_seconds{job="chatapp-api"})'

# Overload stage
PROM_Q_OVERLOAD='max(chatapp_overload_stage{job="chatapp-api"})'

# Delivery timeouts/s
PROM_Q_DELIVERY_TO='sum(rate(delivery_timeout_total{job="chatapp-api"}[$RANGE]))'

# Replay fail-open rate/s
PROM_Q_REPLAY_FAILOPEN='sum(rate(ws_replay_fail_open_total{job="chatapp-api",reason!="disabled"}[$RANGE]))'

# DB host iowait %
PROM_Q_DB_IOWAIT='100 * avg by (instance) (rate(node_cpu_seconds_total{job="db-node",mode="iowait"}[$RANGE]))'

# App host CPU %
PROM_Q_HOST_CPU='100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{job="node",mode="idle"}[$RANGE])))'

# App host memory available %
PROM_Q_HOST_MEM='100 * node_memory_MemAvailable_bytes{job="node"} / node_memory_MemTotal_bytes{job="node"}'

# Redis memory usage %
PROM_Q_REDIS_MEM='100 * redis_memory_used_bytes{job="redis"} / clamp_min(redis_memory_max_bytes{job="redis"},1)'

# Redis eviction rate/s
PROM_Q_REDIS_EVICT='sum(rate(redis_evicted_keys_total{job="redis"}[$RANGE]))'

# Workers up
PROM_Q_WORKERS_UP='sum(up{job="chatapp-api"})'

# Read receipt shed rate by reason
PROM_Q_RR_SHED='sum by (reason) (rate(read_receipt_shed_total{job="chatapp-api"}[$RANGE]))'

# message_post 201 req/s
PROM_Q_POST_201='sum(rate(message_post_response_total{job="chatapp-api",status_code="201"}[$RANGE]))'
