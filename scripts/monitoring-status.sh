#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICES=(prometheus grafana alertmanager loki promtail tempo)

check_http() {
  local label=$1
  local url=$2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)
  if [[ "$code" == "200" ]]; then
    echo "${label}: ok (${url})"
  else
    echo "${label}: down (${url}, http ${code:-n/a})"
  fi
}

echo "=== ChatApp Monitoring Status ==="
docker compose ps "${SERVICES[@]}"
echo
check_http "Grafana" "http://127.0.0.1:3001/api/health"
check_http "Prometheus" "http://127.0.0.1:9090/graph"
check_http "Alertmanager" "http://127.0.0.1:9093/"
check_http "Loki" "http://127.0.0.1:3100/metrics"
check_http "Tempo" "http://127.0.0.1:3200/metrics"

if nc -z 127.0.0.1 4318 >/dev/null 2>&1; then
  echo "Tempo OTLP HTTP: open (127.0.0.1:4318)"
else
  echo "Tempo OTLP HTTP: down (127.0.0.1:4318)"
fi

echo
echo "Grafana dashboard: http://127.0.0.1:3001"
echo "Prometheus UI:    http://127.0.0.1:9090"
echo "Alertmanager UI:  http://127.0.0.1:9093"
