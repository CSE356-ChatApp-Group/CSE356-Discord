#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"
cd "$CHATAPP_REPO_ROOT"

echo "Starting ChatApp monitoring stack..."
docker compose up -d prometheus grafana alertmanager loki promtail tempo node-exporter

echo
"${CHATAPP_REPO_ROOT}/scripts/monitoring/monitoring-status.sh"
