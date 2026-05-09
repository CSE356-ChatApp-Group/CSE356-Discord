#!/usr/bin/env bash
# Install or refresh nginx on a dedicated websocket VM so VM1 can hit *one* address
# per host (CHATAPP_INV_WS_TIER_INTERNAL_LB_PORT, default 4080) with least_conn across
# local chatapp@4000+ workers — reduces consistent-hash skew across workers.
#
# Run on the WS VM as root (deploy-prod-multi.sh SSHs with WSVM*_USER).
# Usage:
#   ./install-ws-tier-internal-lb.sh <listen_port> <worker_count> [<first_worker_port>]
# Example:
#   ./install-ws-tier-internal-lb.sh 4080 6 4000
set -euo pipefail

LISTEN_PORT="${1:?listen port required}"
WORKER_COUNT="${2:?worker count required}"
FIRST_PORT="${3:-4000}"

if ! [[ "${LISTEN_PORT}" =~ ^[1-9][0-9]{1,4}$ ]]; then
  echo "ERROR: invalid listen port: ${LISTEN_PORT}" >&2
  exit 1
fi
if ! [[ "${WORKER_COUNT}" =~ ^[1-9][0-9]{0,2}$ ]]; then
  echo "ERROR: invalid worker count: ${WORKER_COUNT}" >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx
fi

UPSTREAM_SERVERS=""
idx="${FIRST_PORT}"
_end=$((FIRST_PORT + WORKER_COUNT))
while [[ "${idx}" -lt "${_end}" ]]; do
  UPSTREAM_SERVERS+="  server 127.0.0.1:${idx} max_fails=0;"$'\n'
  idx=$((idx + 1))
done

CONF_PATH=/etc/nginx/sites-available/chatapp-ws-internal-lb.conf
ENABLED=/etc/nginx/sites-enabled/chatapp-ws-internal-lb.conf

cat <<EOF | tee "${CONF_PATH}" >/dev/null
# Managed by ChatApp deploy — internal websocket fan-out on dedicated WS tier VMs.
# Edge nginx hashes clients to this host:port; least_conn spreads across local Node workers.

map \$http_upgrade \$connection_upgrade {
  default upgrade;
  ''      close;
}

upstream chatapp_ws_local {
  least_conn;
${UPSTREAM_SERVERS}
  keepalive 256;
  keepalive_requests 10000;
  keepalive_timeout 75s;
}

server {
  listen ${LISTEN_PORT};
  listen [::]:${LISTEN_PORT};
  server_name _;

  location / {
    proxy_pass http://chatapp_ws_local;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_connect_timeout 10s;
    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_next_upstream_tries 3;
  }
}
EOF

ln -sf "${CONF_PATH}" "${ENABLED}"
if [[ -f /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx

echo "OK: ws-tier internal LB listening on ${LISTEN_PORT} -> local workers ${FIRST_PORT}..$((FIRST_PORT + WORKER_COUNT - 1))"
