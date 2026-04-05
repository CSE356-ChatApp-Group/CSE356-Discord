#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Starting ChatApp monitoring stack..."
docker compose up -d prometheus grafana alertmanager loki promtail tempo node-exporter

echo
./scripts/monitoring-status.sh
