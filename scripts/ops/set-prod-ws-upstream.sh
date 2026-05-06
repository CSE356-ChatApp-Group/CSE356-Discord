#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../deploy/inventory-defaults.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../../deploy/inventory-defaults.sh"

PROD_HOST="${PROD_HOST:-${CHATAPP_INV_VM1_PUBLIC}}"
PROD_USER="${PROD_USER:-ubuntu}"
WSVM1_INTERNAL="${WSVM1_INTERNAL:-${CHATAPP_INV_WSVM1_INTERNAL}}"
WSVM2_INTERNAL="${WSVM2_INTERNAL:-${CHATAPP_INV_WSVM2_INTERNAL}}"
WSVM1_WORKERS="${WSVM1_WORKERS:-${CHATAPP_INV_WSVM1_WORKERS}}"
WSVM2_WORKERS="${WSVM2_WORKERS:-${CHATAPP_INV_WSVM2_WORKERS}}"

if [[ -z "${WSVM1_INTERNAL}" ]] && [[ -z "${WSVM2_INTERNAL}" ]]; then
  echo "ERROR: no websocket VM private IPs configured (WSVM1_INTERNAL/WSVM2_INTERNAL)."
  exit 1
fi

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" \
  "WSVM1_INTERNAL='${WSVM1_INTERNAL}' WSVM2_INTERNAL='${WSVM2_INTERNAL}' WSVM1_WORKERS='${WSVM1_WORKERS}' WSVM2_WORKERS='${WSVM2_WORKERS}' bash" <<'REMOTE'
set -euo pipefail
SITE=/etc/nginx/sites-enabled/chatapp
TMP_SITE=$(mktemp)
sudo cp "${SITE}" "${TMP_SITE}"
export TMP_SITE

python3 <<'PY'
import os
import re

cfg_path = os.environ["TMP_SITE"]
keepalive = (
    "  keepalive 256;\n"
    + "  keepalive_requests 10000;\n"
    + "  keepalive_timeout 75s;\n"
)
dollar = chr(36)

map_block = (
    f"map {dollar}arg_token {dollar}ws_sticky_key " + "{\n"
    + "  default " + f"{dollar}arg_token;\n"
    + '  ""      ' + f"{dollar}binary_remote_addr;\n"
    + "}\n\n"
)

servers = []
for key_ip, key_workers in (
    ("WSVM1_INTERNAL", "WSVM1_WORKERS"),
    ("WSVM2_INTERNAL", "WSVM2_WORKERS"),
):
    host = os.environ.get(key_ip, "").strip()
    workers = int(os.environ.get(key_workers, "0") or "0")
    if host and workers > 0:
        for port in range(4000, 4000 + workers):
            servers.append(f"  server {host}:{port} max_fails=0;\n")

if not servers:
    raise SystemExit("no websocket upstream servers configured")

ws_block = (
    "upstream app_ws {\n"
    + f"  hash {dollar}ws_sticky_key consistent;\n"
    + "".join(servers)
    + keepalive
    + "}"
)

text = open(cfg_path).read()
if "ws_sticky_key" not in text:
    text, n_map = re.subn(r"(^\s*upstream app \{)", map_block + r"\1", text, count=1, flags=re.MULTILINE)
    if n_map != 1:
        raise SystemExit(f"failed to insert ws_sticky_key map (n={n_map})")

text, n_ws = re.subn(r"upstream app_ws \{[^}]+\}", ws_block, text, count=1, flags=re.DOTALL)
if n_ws == 0:
    text, n_insert = re.subn(r"(upstream app \{[^}]+\}\n+)", r"\1" + ws_block + "\n", text, count=1, flags=re.DOTALL)
    if n_insert != 1:
        raise SystemExit(f"failed to insert app_ws block (n={n_insert})")
elif n_ws != 1:
    raise SystemExit(f"failed to replace app_ws block (n={n_ws})")

def patch_ws_location(match: re.Match[str]) -> str:
    inner = match.group(1)
    inner, _ = re.subn(r"proxy_pass\s+http://[^;]+;", "proxy_pass http://app_ws;", inner, count=1)
    if "/var/log/nginx/ws_access.log chatapp_ws;" not in inner:
        inner = inner.rstrip() + "\n    access_log /var/log/nginx/ws_access.log chatapp_ws;\n"
    return "location /ws {" + inner + "}"

text, n_loc = re.subn(r"location /ws \{(.*?)\}", patch_ws_location, text, count=1, flags=re.DOTALL)
if n_loc != 1:
    raise SystemExit(f"failed to update /ws location (n={n_loc})")

open(cfg_path, "w").write(text)
PY

sudo install -m 644 "${TMP_SITE}" "${SITE}"
rm -f "${TMP_SITE}"
sudo nginx -t
sudo systemctl reload nginx
echo "Updated /ws to use dedicated websocket VMs on ${SITE}"
REMOTE
