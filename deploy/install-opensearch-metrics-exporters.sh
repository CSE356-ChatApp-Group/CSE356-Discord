#!/usr/bin/env bash
# deploy/install-opensearch-metrics-exporters.sh
#
# Install prometheus-node-exporter + elasticsearch_exporter on the dedicated
# search VM (currently meilisearch-vm @ 10.0.0.146 in prod) so the production
# monitoring VM Prometheus can scrape:
#
#   - host CPU/RAM/disk via node_exporter (:9100)
#   - OpenSearch cluster/node/index/threadpool/heap metrics via
#     elasticsearch_exporter (:9114, OpenSearch-compatible)
#
# Why a sidecar exporter and not the OpenSearch Prometheus plugin?
#   - The plugin would require modifying the OpenSearch container image and
#     restarting OpenSearch (write-side disruption).
#   - elasticsearch_exporter is a standalone Go binary that scrapes the
#     existing HTTP API on 10.0.0.146:9200 — no OpenSearch restart, no
#     container changes.
#
# Prerequisites:
#   - OpenSearch 2.x reachable from the host on http://10.0.0.146:9200
#     (already true on prod meilisearch-vm)
#   - sudo access on the target host
#   - The monitoring VM private IP (defaults to 10.0.1.102) is allowed
#     through UFW for ports 9100 and 9114.
#
# Usage (run from the production monitoring VM, which already has SSH keys
# to ubuntu@10.0.0.146):
#
#   ssh ubuntu@130.245.136.120
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/install-opensearch-metrics-exporters.sh \
#     -o install-opensearch-metrics-exporters.sh   # or scp from this checkout
#   scp install-opensearch-metrics-exporters.sh ubuntu@10.0.0.146:
#   ssh ubuntu@10.0.0.146 "bash install-opensearch-metrics-exporters.sh"
#
# Or from your laptop, if you have a working SSH path through the monitoring VM:
#
#   ssh -J ubuntu@130.245.136.120 ubuntu@10.0.0.146 \
#       "bash -s" < deploy/install-opensearch-metrics-exporters.sh
#
# After this:
#   - prometheus-host.yml on the monitoring VM must include the new
#     `meilisearch-vm-node` and `opensearch` jobs (already in the repo
#     template). Trigger a monitoring sync (deploy-prod-multi-style) to push.
#   - Verify: curl from monitoring VM:
#       curl -fsS http://10.0.0.146:9100/metrics | head
#       curl -fsS http://10.0.0.146:9114/metrics | head
#
# Idempotent — safe to re-run.

set -euo pipefail

ES_EXPORTER_VERSION="${ES_EXPORTER_VERSION:-1.7.0}"
ES_EXPORTER_PORT="${ES_EXPORTER_PORT:-9114}"
ES_URI="${ES_URI:-http://10.0.0.146:9200}"
NODE_EXPORTER_PORT="${NODE_EXPORTER_PORT:-9100}"
MONITORING_VM_PRIVATE_IP="${MONITORING_VM_PRIVATE_IP:-10.0.1.102}"

if [[ "$EUID" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "ERROR: must run as root or have sudo available" >&2
    exit 1
  fi
  SUDO=sudo
else
  SUDO=
fi

echo "=== install-opensearch-metrics-exporters on $(hostname) ==="
echo "  elasticsearch_exporter: ${ES_EXPORTER_VERSION} listening on :${ES_EXPORTER_PORT}, scraping ${ES_URI}"
echo "  node_exporter:          listening on :${NODE_EXPORTER_PORT}"
echo "  ufw allow from:         ${MONITORING_VM_PRIVATE_IP}"

# ── 1. node_exporter (apt) ─────────────────────────────────────────────────
echo ""
echo "1) Installing prometheus-node-exporter via apt..."
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq prometheus-node-exporter
$SUDO systemctl enable --now prometheus-node-exporter
$SUDO systemctl is-active --quiet prometheus-node-exporter \
  || { echo "ERROR: prometheus-node-exporter failed to start"; exit 1; }

# ── 2. elasticsearch_exporter (binary release) ──────────────────────────────
echo ""
echo "2) Installing elasticsearch_exporter ${ES_EXPORTER_VERSION}..."
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64)  ESE_ARCH=amd64 ;;
  aarch64) ESE_ARCH=arm64 ;;
  *) echo "ERROR: Unsupported arch ${ARCH}"; exit 1 ;;
esac

ESE_BIN=/usr/local/bin/elasticsearch_exporter
ESE_CURRENT=""
if [[ -x "${ESE_BIN}" ]]; then
  ESE_CURRENT="$("${ESE_BIN}" --version 2>&1 | head -1 | awk '{print $3}' || echo unknown)"
fi
if [[ "${ESE_CURRENT}" != "${ES_EXPORTER_VERSION}" ]]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "${TMP}"' EXIT
  TARBALL="elasticsearch_exporter-${ES_EXPORTER_VERSION}.linux-${ESE_ARCH}.tar.gz"
  URL="https://github.com/prometheus-community/elasticsearch_exporter/releases/download/v${ES_EXPORTER_VERSION}/${TARBALL}"
  echo "   downloading ${URL}"
  curl -fsSL -o "${TMP}/${TARBALL}" "${URL}"
  tar -xzf "${TMP}/${TARBALL}" -C "${TMP}"
  EXTRACTED="$(find "${TMP}" -name elasticsearch_exporter -type f | head -1)"
  [[ -n "${EXTRACTED}" ]] || { echo "ERROR: elasticsearch_exporter binary not in archive"; exit 1; }
  $SUDO install -m 0755 "${EXTRACTED}" "${ESE_BIN}"
else
  echo "   already at ${ES_EXPORTER_VERSION} — skipping download"
fi

# Dedicated unprivileged user (idempotent)
if ! id -u elasticsearch_exporter >/dev/null 2>&1; then
  $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin elasticsearch_exporter
fi

# Systemd unit
UNIT_PATH=/etc/systemd/system/elasticsearch_exporter.service
$SUDO tee "${UNIT_PATH}" >/dev/null <<UNIT
[Unit]
Description=Prometheus Elasticsearch / OpenSearch exporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=elasticsearch_exporter
Group=elasticsearch_exporter
ExecStart=${ESE_BIN} \\
  --es.uri=${ES_URI} \\
  --es.all \\
  --es.cluster_settings \\
  --es.indices \\
  --es.indices_settings \\
  --es.shards \\
  --web.listen-address=0.0.0.0:${ES_EXPORTER_PORT}
Restart=on-failure
RestartSec=5s

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now elasticsearch_exporter
$SUDO systemctl restart elasticsearch_exporter
$SUDO systemctl is-active --quiet elasticsearch_exporter \
  || { echo "ERROR: elasticsearch_exporter failed to start"; $SUDO journalctl -u elasticsearch_exporter -n 30 --no-pager; exit 1; }

# ── 3. UFW: allow monitoring VM only (idempotent) ───────────────────────────
echo ""
echo "3) UFW: allow ${MONITORING_VM_PRIVATE_IP} → :${NODE_EXPORTER_PORT}, :${ES_EXPORTER_PORT}"
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  for port in "${NODE_EXPORTER_PORT}" "${ES_EXPORTER_PORT}"; do
    if $SUDO ufw status | grep -E "^${port}/tcp\b.*ALLOW IN.*${MONITORING_VM_PRIVATE_IP}\b" >/dev/null; then
      echo "   ${port}/tcp ALLOW from ${MONITORING_VM_PRIVATE_IP} already present"
    else
      $SUDO ufw allow proto tcp from "${MONITORING_VM_PRIVATE_IP}" to any port "${port}" \
        comment "monitoring VM scrape (${port})"
    fi
  done
else
  echo "   UFW not active; skipping firewall update."
fi

# ── 4. Smoke check ──────────────────────────────────────────────────────────
echo ""
echo "4) Smoke: scrape locally"
NODE_OK=0; ESE_OK=0
if curl -fsS --max-time 5 "http://127.0.0.1:${NODE_EXPORTER_PORT}/metrics" >/dev/null; then
  NODE_OK=1
fi
if curl -fsS --max-time 5 "http://127.0.0.1:${ES_EXPORTER_PORT}/metrics" >/dev/null; then
  ESE_OK=1
fi
printf "   node_exporter@%s: %s\n"          "${NODE_EXPORTER_PORT}" "$([[ ${NODE_OK} -eq 1 ]] && echo OK || echo FAIL)"
printf "   elasticsearch_exporter@%s: %s\n" "${ES_EXPORTER_PORT}"   "$([[ ${ESE_OK} -eq 1 ]] && echo OK || echo FAIL)"

[[ ${NODE_OK} -eq 1 && ${ESE_OK} -eq 1 ]] || { echo "ERROR: at least one exporter not responding"; exit 1; }

echo ""
echo "✓ exporters active. Next steps from the monitoring VM:"
echo "    1. Pull prometheus-host.yml change (already in repo) onto the monitoring VM"
echo "    2. sudo docker restart chatapp-monitoring-prometheus-1"
echo "    3. curl 'http://127.0.0.1:9090/api/v1/targets?state=active' | jq '.data.activeTargets[] | select(.scrapePool|test(\"opensearch|meili\"))'"
