#!/bin/bash
# deploy/deploy-prod-monitoring-sync.sh
# Background monitoring refresh for deploy-prod.sh (single-VM prod).
# Sourced after deploy-common (scp helpers) and ssh_monitor / ssh_prod exist.
# shellcheck shell=bash

deploy_prod_start_monitoring_refresh_background() {
  local REPO_ROOT
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  (
    set +e # failures here are warnings, not deploy failures

    if [ "${SKIP_MONITORING_SYNC:-0}" = "1" ]; then
      echo "SKIP_MONITORING_SYNC=1 — skipping monitoring stack sync (handled by orchestrator)"
      exit 0
    fi

    # 10.55. Render prometheus-host.yml with correct app-VM targets.
# In multi-VM mode (PROM_VM1_WORKERS > 0) all three VMs are included so Prometheus
# scrapes chatapp-api, node_exporter, and pgbouncer on every app host.
echo "10.55. Rendering prometheus-host.yml..."
PROM_BUILD="$(mktemp)"
PROM_APP_HOST="${PROM_APP_HOST:-$(ssh_prod 'hostname -I 2>/dev/null' | awk '{print $1}')}"
PROM_APP_HOST="${PROM_APP_HOST:-10.0.0.237}"
if [ "${PROM_VM1_WORKERS:-0}" -gt 0 ]; then
  PROM_EXTRA_ARGS=""
  [ -n "${PROM_VM2_HOST:-}" ] && [ "${PROM_VM2_WORKERS:-0}" -gt 0 ] && \
    PROM_EXTRA_ARGS="$PROM_EXTRA_ARGS --vm2-host ${PROM_VM2_HOST} --vm2-workers ${PROM_VM2_WORKERS}"
  [ -n "${PROM_VM3_HOST:-}" ] && [ "${PROM_VM3_WORKERS:-0}" -gt 0 ] && \
    PROM_EXTRA_ARGS="$PROM_EXTRA_ARGS --vm3-host ${PROM_VM3_HOST} --vm3-workers ${PROM_VM3_WORKERS}"
  # shellcheck disable=SC2086
  python3 "${SCRIPT_DIR}/render-prometheus-host-config.py" \
    --template "${REPO_ROOT}/infrastructure/monitoring/prometheus-host.yml" \
    --output "${PROM_BUILD}" \
    --app-host "${PROM_APP_HOST}" \
    --vm1-workers "${PROM_VM1_WORKERS}" \
    $PROM_EXTRA_ARGS
else
  python3 "${SCRIPT_DIR}/render-prometheus-host-config.py" \
    --template "${REPO_ROOT}/infrastructure/monitoring/prometheus-host.yml" \
    --output "${PROM_BUILD}" \
    --app-host "${PROM_APP_HOST}" \
    --workers "${CHATAPP_INSTANCES}"
fi

# 10.6. Push rendered prometheus-host.yml to the monitoring VM and reload Prometheus.
echo "10.6. Refreshing Prometheus scrape config on monitoring VM (${MONITORING_VM_HOST})..."
chatapp_scp_to_monitor "${PROM_BUILD}" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/prometheus-host.yml.deploy" || true
rm -f "${PROM_BUILD}"
ssh_monitor "
  if [ -f /tmp/prometheus-host.yml.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
    sudo cp /tmp/prometheus-host.yml.deploy /opt/chatapp-monitoring/prometheus-host.yml
    rm -f /tmp/prometheus-host.yml.deploy
  fi
  PROM_TMPL=/opt/chatapp-monitoring/prometheus-host.yml
  if [ -f \"\$PROM_TMPL\" ]; then
    if sudo docker restart chatapp-monitoring-prometheus-1 >/dev/null 2>&1; then
      echo 'Prometheus restarted on monitoring VM'
    else
      echo 'WARN: Prometheus restart failed on monitoring VM (non-fatal)'
    fi
  else
    echo 'WARN: prometheus-host.yml not found on monitoring VM, skipping Prometheus update'
  fi
" || echo "⚠ Prometheus target update failed (non-fatal)"

echo "10.65. Sync monitoring stack to monitoring VM (${MONITORING_VM_HOST})..."
ENV_PULL="$(mktemp)"
chatapp_scp_from_prod "/opt/chatapp/shared/.env" "${ENV_PULL}" || true

chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/alerts.yml" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/alerts.yml.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/alertmanager.yml" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/alertmanager.yml.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/monitoring-compose.yml" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/monitoring-compose.yml.deploy" || true
chatapp_scp_recursive_to_monitor "${REPO_ROOT}/infrastructure/monitoring/grafana-provisioning-remote" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/grafana-provisioning-remote.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/deploy/prometheus-db-file-sd.py" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/prometheus-db-file-sd.py.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/file_sd/db-node.json" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/db-node.json.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/file_sd/db-postgres.json" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/db-postgres.json.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/loki-config.yml" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/loki-config.yml.deploy" || true
chatapp_scp_to_monitor "${REPO_ROOT}/infrastructure/monitoring/tempo-config.yml" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/tempo-config.yml.deploy" || true
if [ -f "${ENV_PULL}" ]; then
  chatapp_scp_to_monitor "${ENV_PULL}" "${MONITORING_VM_USER}@${MONITORING_VM_HOST}:/tmp/chatapp-monitoring.env.deploy" || true
fi
rm -f "${ENV_PULL}"

ssh_monitor "
  set -euo pipefail
  sudo mkdir -p /opt/chatapp-monitoring/file_sd
  if [ -d /tmp/grafana-provisioning-remote.deploy ]; then
    sudo rm -rf /opt/chatapp-monitoring/grafana-provisioning-remote
    sudo mv /tmp/grafana-provisioning-remote.deploy /opt/chatapp-monitoring/grafana-provisioning-remote
  fi
  if [ -f /tmp/monitoring-compose.yml.deploy ]; then
    sudo cp /tmp/monitoring-compose.yml.deploy /opt/chatapp-monitoring/monitoring-compose.yml
    rm -f /tmp/monitoring-compose.yml.deploy
  fi
  if [ -f /tmp/loki-config.yml.deploy ]; then
    sudo cp /tmp/loki-config.yml.deploy /opt/chatapp-monitoring/loki-config.yml
    rm -f /tmp/loki-config.yml.deploy
  fi
  if [ -f /tmp/tempo-config.yml.deploy ]; then
    sudo cp /tmp/tempo-config.yml.deploy /opt/chatapp-monitoring/tempo-config.yml
    rm -f /tmp/tempo-config.yml.deploy
  fi
  if [ -f /tmp/prometheus-db-file-sd.py.deploy ]; then
    sudo cp /tmp/prometheus-db-file-sd.py.deploy /opt/chatapp-monitoring/prometheus-db-file-sd.py
    sudo chmod 644 /opt/chatapp-monitoring/prometheus-db-file-sd.py
    rm -f /tmp/prometheus-db-file-sd.py.deploy
  fi
  if [ -f /tmp/db-node.json.deploy ]; then
    sudo cp /tmp/db-node.json.deploy /opt/chatapp-monitoring/file_sd/db-node.json
    rm -f /tmp/db-node.json.deploy
  fi
  if [ -f /tmp/db-postgres.json.deploy ]; then
    sudo cp /tmp/db-postgres.json.deploy /opt/chatapp-monitoring/file_sd/db-postgres.json
    rm -f /tmp/db-postgres.json.deploy
  fi
  if [ -f /tmp/alerts.yml.deploy ]; then
    sudo cp /tmp/alerts.yml.deploy /opt/chatapp-monitoring/alerts.yml
    rm -f /tmp/alerts.yml.deploy
  fi
  if [ -f /tmp/alertmanager.yml.deploy ]; then
    sudo cp /tmp/alertmanager.yml.deploy /opt/chatapp-monitoring/alertmanager.yml
    rm -f /tmp/alertmanager.yml.deploy
  fi
  if [ -f /tmp/chatapp-monitoring.env.deploy ]; then
    sudo cp /tmp/chatapp-monitoring.env.deploy /opt/chatapp-monitoring/.env
    rm -f /tmp/chatapp-monitoring.env.deploy
  fi
  if [ -f /opt/chatapp-monitoring/.env ]; then
    sudo sed -i 's/^ALERT_ENVIRONMENT=.*/ALERT_ENVIRONMENT=production/' /opt/chatapp-monitoring/.env
    if ! sudo grep -q '^ALERT_ENVIRONMENT=' /opt/chatapp-monitoring/.env; then
      echo 'ALERT_ENVIRONMENT=production' | sudo tee -a /opt/chatapp-monitoring/.env >/dev/null
    fi
  fi
  if [ -f /opt/chatapp-monitoring/prometheus-db-file-sd.py ] && [ -f /opt/chatapp-monitoring/.env ]; then
    sudo env CHATAPP_ENV_FILE=/opt/chatapp-monitoring/.env python3 /opt/chatapp-monitoring/prometheus-db-file-sd.py || echo 'WARN: prometheus-db-file-sd.py failed on monitoring VM (non-fatal)'
  fi
  if [ -f /opt/chatapp-monitoring/.env ] && [ -f /opt/chatapp-monitoring/monitoring-compose.yml ]; then
    sudo docker compose --env-file /opt/chatapp-monitoring/.env -f /opt/chatapp-monitoring/monitoring-compose.yml up -d --remove-orphans prometheus alertmanager grafana loki tempo >/dev/null
  fi
  AM_NAME=\$(sudo docker ps --format '{{.Names}}' | grep 'alertmanager' | head -n 1 || true)
  if [ -z \"\$AM_NAME\" ]; then
    echo 'ERROR: alertmanager container not running on monitoring VM after refresh'
    exit 1
  fi
  WEBHOOK_HEAD=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"head -c 8 /alertmanager/secrets/discord_webhook_url 2>/dev/null || true\")
  WEBHOOK_BYTES=\$(sudo docker exec \"\$AM_NAME\" sh -lc \"wc -c < /alertmanager/secrets/discord_webhook_url 2>/dev/null || echo 0\")
  if [ \"\$WEBHOOK_HEAD\" != \"https://\" ] || [ \"\${WEBHOOK_BYTES:-0}\" -lt 32 ]; then
    echo \"ERROR: Alertmanager webhook secret invalid on monitoring VM (head=\$WEBHOOK_HEAD bytes=\$WEBHOOK_BYTES)\"
    exit 1
  fi
  echo 'Alertmanager Discord webhook wiring verified (monitoring VM)'
"

chatapp_scp_to_prod "${REPO_ROOT}/infrastructure/monitoring/remote-compose.yml" "$PROD_USER@$PROD_HOST:/tmp/remote-compose.yml.deploy" || true
chatapp_scp_to_prod "${REPO_ROOT}/infrastructure/monitoring/promtail-host-config.yml" "$PROD_USER@$PROD_HOST:/tmp/promtail-host-config.yml.deploy" || true
chatapp_scp_to_prod "${REPO_ROOT}/scripts/ops/synthetic-probe.sh" "$PROD_USER@$PROD_HOST:/tmp/synthetic-probe.sh.deploy" || true
chatapp_scp_to_prod "${REPO_ROOT}/deploy/pgbouncer-exporter.py" "$PROD_USER@$PROD_HOST:/tmp/pgbouncer-exporter.py.deploy" || true
chatapp_scp_to_prod "${REPO_ROOT}/deploy/redis_exporter_redis_url.py" "$PROD_USER@$PROD_HOST:/tmp/redis_exporter_redis_url.py.deploy" \
  || echo "WARN: could not copy redis_exporter_redis_url.py (redis_exporter may use fallback)" >&2
ssh_prod "
  set -euo pipefail
  if [ -f /tmp/remote-compose.yml.deploy ] || [ -f /tmp/promtail-host-config.yml.deploy ] || [ -f /tmp/synthetic-probe.sh.deploy ] || [ -f /tmp/pgbouncer-exporter.py.deploy ]; then
    sudo mkdir -p /opt/chatapp-monitoring
  fi
  sudo mkdir -p /opt/chatapp-monitoring/node_exporter_textfile
  sudo chown ${PROD_USER}:${PROD_USER} /opt/chatapp-monitoring/node_exporter_textfile
  if [ -f /tmp/synthetic-probe.sh.deploy ]; then
    sudo install -m 755 /tmp/synthetic-probe.sh.deploy /opt/chatapp-monitoring/synthetic-probe.sh
    rm -f /tmp/synthetic-probe.sh.deploy
  fi
  if [ -x /opt/chatapp-monitoring/synthetic-probe.sh ]; then
    (
      crontab -l 2>/dev/null | grep -v '/opt/chatapp-monitoring/synthetic-probe.sh' || true
      echo '*/2 * * * * TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile CURL_MAX_TIME=12 /opt/chatapp-monitoring/synthetic-probe.sh >/dev/null 2>&1'
    ) | crontab -
  fi
  if [ -f /tmp/remote-compose.yml.deploy ]; then
    sudo cp /tmp/remote-compose.yml.deploy /opt/chatapp-monitoring/remote-compose.yml
    rm -f /tmp/remote-compose.yml.deploy
  fi
  if [ -f /tmp/promtail-host-config.yml.deploy ]; then
    sudo cp /tmp/promtail-host-config.yml.deploy /opt/chatapp-monitoring/promtail-host-config.yml
    rm -f /tmp/promtail-host-config.yml.deploy
  fi
  if [ -f /opt/chatapp-monitoring/remote-compose.yml ]; then
    sudo docker compose -f /opt/chatapp-monitoring/remote-compose.yml up -d --remove-orphans node-exporter promtail >/dev/null
  fi
  if [ -f /tmp/redis_exporter_redis_url.py.deploy ]; then
    sudo install -m 755 /tmp/redis_exporter_redis_url.py.deploy /opt/chatapp-monitoring/redis_exporter_redis_url.py
    rm -f /tmp/redis_exporter_redis_url.py.deploy
  fi
  if [ -x /opt/chatapp-monitoring/redis_exporter_redis_url.py ]; then
    RURL=\$(python3 /opt/chatapp-monitoring/redis_exporter_redis_url.py)
  else
    set -a
    # shellcheck disable=SC1091
    source /opt/chatapp/shared/.env 2>/dev/null || true
    set +a
    RURL=\"\${REDIS_URL:-redis://127.0.0.1:6379}\"
  fi
  ENVF=/opt/chatapp-monitoring/redis_exporter_runtime.env
  printf 'REDIS_ADDR=%s\\n' \"\$RURL\" | sudo tee \"\$ENVF\" >/dev/null
  sudo chmod 600 \"\$ENVF\"
  sudo docker rm -f redis_exporter 2>/dev/null || true
  sudo docker pull oliver006/redis_exporter:latest >/dev/null
  sudo docker run -d --name redis_exporter --restart unless-stopped --network host \\
    --env-file \"\$ENVF\" \\
    oliver006/redis_exporter:latest >/dev/null
  sudo rm -f \"\$ENVF\"
  echo 'redis_exporter (re)started (REDIS_ADDR from merged .env via redis_exporter_redis_url.py)'

  if [ -f /tmp/pgbouncer-exporter.py.deploy ]; then
    sudo install -m 755 /tmp/pgbouncer-exporter.py.deploy /opt/chatapp-monitoring/pgbouncer-exporter.py
    rm -f /tmp/pgbouncer-exporter.py.deploy
  fi

  if [ -f /opt/chatapp-monitoring/pgbouncer-exporter.py ]; then
    sudo tee /etc/systemd/system/pgbouncer-exporter.service > /dev/null <<'UNIT'
[Unit]
Description=PgBouncer Prometheus exporter
After=network.target pgbouncer.service
Wants=pgbouncer.service

[Service]
Type=simple
User=nobody
ExecStart=/usr/bin/python3 /opt/chatapp-monitoring/pgbouncer-exporter.py --listen 0.0.0.0:9126 --pgbouncer 127.0.0.1:6432
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable pgbouncer-exporter 2>/dev/null || true
    sudo systemctl restart pgbouncer-exporter
    sleep 1
    if sudo systemctl is-active --quiet pgbouncer-exporter; then
      echo 'pgbouncer-exporter started on :9126/metrics'
    else
      echo 'Warning: pgbouncer-exporter failed to start (non-critical)' >&2
    fi
  fi
"
echo "✓ Monitoring updated"

  ) &
  # shellcheck disable=SC2034 # deploy-prod.sh waits on this PID after background refresh
  _MONITORING_BG_PID=$!
}
