#!/bin/bash
# deploy/meilisearch-vm-setup.sh
#
# One-time bootstrap for the dedicated Meilisearch VM (meilisearch-vm).
# Private IP: 10.0.0.146  —  4 vCPU, 8 GB RAM, 64 GB storage
#
# Run as the ubuntu user (sudo access required):
#   scp deploy/meilisearch-vm-setup.sh ubuntu@10.0.0.146:
#   ssh ubuntu@10.0.0.146 "MEILI_MASTER_KEY=<secret> bash meilisearch-vm-setup.sh"
#
# Safe to rerun; installs the latest Meilisearch v1.x binary if not already
# present at the right version.
#
# Security model:
#   - Meilisearch binds only to 127.0.0.1 and the private interface (10.0.0.146).
#   - Port 7700 is NOT exposed to the public internet.
#   - ufw rules allow 7700/tcp from the app-VM private subnet (10.0.0.0/8) only.
#   - MEILI_MASTER_KEY is required; startup fails without it.
#
# After this script: run the index setup from any app VM:
#   MEILI_HOST=http://10.0.0.146:7700 MEILI_MASTER_KEY=<secret> \
#     npm --prefix /opt/chatapp/current/backend run meili:setup-index

set -euo pipefail

MEILI_VERSION="${MEILI_VERSION:-1.8.0}"
MEILI_DATA_DIR="${MEILI_DATA_DIR:-/var/lib/meilisearch}"
MEILI_CONFIG_DIR="/etc/meilisearch"
MEILI_LOG_DIR="/var/log/meilisearch"
MEILI_USER="meilisearch"
MEILI_PORT="7700"
PRIVATE_IP="${PRIVATE_IP:-10.0.0.146}"

if [[ -z "${MEILI_MASTER_KEY:-}" ]]; then
  echo "ERROR: MEILI_MASTER_KEY must be set (min 16 chars)."
  echo "  Export it or pass it inline:"
  echo "    MEILI_MASTER_KEY=<secret> bash $0"
  exit 1
fi

echo "=== Meilisearch VM Bootstrap ==="
echo "Host:       $(hostname)"
echo "Private IP: ${PRIVATE_IP}"
echo "Version:    ${MEILI_VERSION}"
echo "Data dir:   ${MEILI_DATA_DIR}"

# ── 1 · System packages ───────────────────────────────────────────────────────
echo ""
echo "1) Installing base packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates ufw

# ── 2 · Meilisearch binary ────────────────────────────────────────────────────
echo ""
echo "2) Installing Meilisearch ${MEILI_VERSION}..."
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  MEILI_ARCH="amd64" ;;
  aarch64) MEILI_ARCH="aarch64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac
MEILI_BIN="/usr/local/bin/meilisearch"
MEILI_URL="https://github.com/meilisearch/meilisearch/releases/download/v${MEILI_VERSION}/meilisearch-linux-${MEILI_ARCH}"

INSTALL_MEILI=true
if [[ -f "$MEILI_BIN" ]]; then
  INSTALLED_VER="$($MEILI_BIN --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo 'unknown')"
  if [[ "$INSTALLED_VER" == "$MEILI_VERSION" ]]; then
    echo "   Already at v${MEILI_VERSION} — skipping download."
    INSTALL_MEILI=false
  else
    echo "   Upgrading from v${INSTALLED_VER} to v${MEILI_VERSION}..."
    sudo systemctl stop meilisearch 2>/dev/null || true
  fi
fi

if [[ "$INSTALL_MEILI" == "true" ]]; then
  TMP="$(mktemp)"
  curl -fsSL "$MEILI_URL" -o "$TMP"
  sudo install -m 0755 "$TMP" "$MEILI_BIN"
  rm -f "$TMP"
  echo "   Installed: $($MEILI_BIN --version)"
fi

# ── 3 · Dedicated user ────────────────────────────────────────────────────────
echo ""
echo "3) Creating system user '${MEILI_USER}'..."
if ! id "$MEILI_USER" &>/dev/null; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$MEILI_USER"
  echo "   Created user ${MEILI_USER}."
else
  echo "   User ${MEILI_USER} already exists."
fi

# ── 4 · Directories ───────────────────────────────────────────────────────────
echo ""
echo "4) Creating directories..."
sudo mkdir -p "$MEILI_DATA_DIR" "$MEILI_CONFIG_DIR" "$MEILI_LOG_DIR"
sudo chown -R "$MEILI_USER:$MEILI_USER" "$MEILI_DATA_DIR" "$MEILI_LOG_DIR"
sudo chmod 750 "$MEILI_DATA_DIR"

# ── 5 · Environment file ──────────────────────────────────────────────────────
echo ""
echo "5) Writing environment file ${MEILI_CONFIG_DIR}/env..."
sudo tee "$MEILI_CONFIG_DIR/env" > /dev/null <<EOF
MEILI_DB_PATH=${MEILI_DATA_DIR}
MEILI_HTTP_ADDR=${PRIVATE_IP}:${MEILI_PORT}
MEILI_MASTER_KEY=${MEILI_MASTER_KEY}
MEILI_ENV=production
MEILI_NO_ANALYTICS=true
MEILI_LOG_LEVEL=INFO
EOF
sudo chmod 600 "$MEILI_CONFIG_DIR/env"
sudo chown root:root "$MEILI_CONFIG_DIR/env"
echo "   Written (permissions: 600, owner: root)."

# ── 6 · systemd unit ─────────────────────────────────────────────────────────
echo ""
echo "6) Installing systemd service..."
sudo tee /etc/systemd/system/meilisearch.service > /dev/null <<'UNIT'
[Unit]
Description=Meilisearch search engine
Documentation=https://www.meilisearch.com/docs
After=network.target
Wants=network.target

[Service]
Type=simple
User=meilisearch
Group=meilisearch
EnvironmentFile=/etc/meilisearch/env
ExecStart=/usr/local/bin/meilisearch
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=meilisearch
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/meilisearch /var/log/meilisearch

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable meilisearch
echo "   Service installed and enabled."

# ── 7 · Firewall ─────────────────────────────────────────────────────────────
echo ""
echo "7) Configuring ufw firewall..."
sudo ufw --force enable 2>/dev/null || true
# Allow SSH from anywhere (preserve existing access)
sudo ufw allow 22/tcp comment 'SSH' 2>/dev/null || true
# Allow Meilisearch only from private /8 subnet (app VMs)
sudo ufw allow from 10.0.0.0/8 to any port ${MEILI_PORT} proto tcp comment 'Meilisearch private' 2>/dev/null || true
# Deny Meilisearch from all other sources (public internet)
sudo ufw deny ${MEILI_PORT}/tcp comment 'Meilisearch deny public' 2>/dev/null || true
sudo ufw status verbose
echo ""
echo "   Firewall rule: 7700/tcp open only to 10.0.0.0/8 (app VMs)."
echo "   Meilisearch is NOT reachable from the public internet."

# ── 8 · Start service ─────────────────────────────────────────────────────────
echo ""
echo "8) Starting Meilisearch..."
sudo systemctl start meilisearch
sleep 3

# ── 9 · Health check ─────────────────────────────────────────────────────────
echo ""
echo "9) Health check..."
MAX_WAIT=30
WAITED=0
until curl -sf "http://${PRIVATE_IP}:${MEILI_PORT}/health" | grep -q '"available"'; do
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    echo "ERROR: Meilisearch did not become healthy within ${MAX_WAIT}s."
    sudo journalctl -u meilisearch --no-pager -n 30
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done
echo "   ✅ Meilisearch is healthy at http://${PRIVATE_IP}:${MEILI_PORT}"

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "Next steps:"
echo "  1. From an app VM, run index setup:"
echo "       MEILI_HOST=http://${PRIVATE_IP}:${MEILI_PORT} \\"
echo "       MEILI_MASTER_KEY=<secret> \\"
echo "       npm --prefix /opt/chatapp/current/backend run meili:setup-index"
echo ""
echo "  2. Run backfill:"
echo "       MEILI_HOST=http://${PRIVATE_IP}:${MEILI_PORT} \\"
echo "       MEILI_MASTER_KEY=<secret> \\"
echo "       DATABASE_URL=<url> \\"
echo "       npm --prefix /opt/chatapp/current/backend run meili:backfill"
echo ""
echo "  3. Verify:"
echo "       npm --prefix /opt/chatapp/current/backend run meili:health"
echo ""
echo "  4. To activate Meili for search on staging/prod:"
echo "       Add to shared/.env on app VMs:"
echo "         MEILI_ENABLED=true"
echo "         SEARCH_BACKEND=meili"
echo "       Then redeploy."
