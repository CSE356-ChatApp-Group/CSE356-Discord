#!/usr/bin/env bash
# Instant Prometheus queries via SSH to the prod DB monitoring host.
# Usage:
#   chmod +x scripts/prod-prom-snapshot.sh
#   PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/prod-prom-snapshot.sh
set -euo pipefail

PROD_DB_SSH="${PROD_DB_SSH:-ubuntu@130.245.136.21}"
PROM_CONTAINER="${PROM_CONTAINER:-chatapp-monitoring-prometheus-1}"

ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_DB_SSH}" \
  "PROM_CONTAINER=${PROM_CONTAINER}" \
  bash -s <<'REMOTE'
set -euo pipefail
PROM_CONTAINER="${PROM_CONTAINER:-chatapp-monitoring-prometheus-1}"
prom_query() {
  local q="$1"
  local enc
  enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$q")
  sudo docker exec "${PROM_CONTAINER}" wget -qO- "http://127.0.0.1:9090/api/v1/query?query=${enc}"
}

echo "=== p99 POST /api/v1/messages/ aggregate (5m) ==="
prom_query 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",route="/api/v1/messages/"}[5m])))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('data',{}).get('result',[]); print(r[0]['value'][1] if r else 'no data')"

echo "=== p99 POST /messages by instance (5m) ==="
prom_query 'histogram_quantile(0.99, sum by (le,instance) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",route="/api/v1/messages/"}[5m])))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin);\
rows=[(float(r['value'][1]), r['metric'].get('instance','')) for r in d.get('data',{}).get('result',[])];\
rows.sort(reverse=True);\
[print(f'{v:10.0f} ms  {inst}') for v,inst in rows]"

echo "=== message_post 201 aggregate req/s (5m) ==="
prom_query 'sum(rate(message_post_response_total{job="chatapp-api",status_code="201"}[5m]))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('data',{}).get('result',[]); print(r[0]['value'][1] if r else 'no data')"

echo "=== message_post_response rate by status_code (5m) ==="
prom_query 'sum by (status_code) (rate(message_post_response_total{job="chatapp-api"}[5m]))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin);\
[print(r['metric'], r['value'][1]) for r in sorted(d.get('data',{}).get('result',[]), key=lambda x: str(x.get('metric',{})))]"

echo "=== pg_pool_circuit_breaker_rejects/s by instance (15m) ==="
prom_query 'sum by (instance) (rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[15m]))' \
  | python3 -c "import sys,json; d=json.load(sys.stdin);\
[print(r['metric'], r['value'][1]) for r in d.get('data',{}).get('result',[])]"

echo "=== workers up (expect 5) ==="
prom_query 'sum(up{job="chatapp-api"})' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('data',{}).get('result',[]); print(r[0]['value'][1] if r else 'no data')"
REMOTE
