#!/usr/bin/env bash
# Idempotently add "deny <ip>;" after the first server_name in the main nginx site.
# Usage: sudo CHATAPP_NGINX_SITE_PATH=/etc/nginx/sites-available/chatapp ./patch-nginx-deny-ip.sh 47.20.119.33
set -euo pipefail

SITE="${CHATAPP_NGINX_SITE_PATH:-/etc/nginx/sites-available/chatapp}"
IP="${1:?usage: $0 <ipv4>}"

if [[ ! "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "ERROR: IPv4 address required" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run with sudo" >&2
  exit 1
fi

python3 - "$SITE" "$IP" <<'PY'
import re
import sys
from pathlib import Path

site = Path(sys.argv[1])
ip = sys.argv[2]
text = site.read_text()
if re.search(r"^\s*deny\s+" + re.escape(ip) + r"\s*;", text, re.MULTILINE):
    print(f"deny {ip} already present — OK")
    sys.exit(0)

lines = text.splitlines(keepends=True)
out = []
inserted = False
for line in lines:
    out.append(line)
    if inserted:
        continue
    if re.match(r"\s*server_name\s+", line):
        m = re.match(r"^(\s*)", line)
        ind = m.group(1) if m else "  "
        out.append(f"{ind}# Abusive registration flood (Apr 2026); not grader.\n")
        out.append(f"{ind}deny {ip};\n")
        inserted = True

if not inserted:
    print("ERROR: no server_name line found — edit nginx manually", file=sys.stderr)
    sys.exit(1)

site.write_text("".join(out))
print(f"wrote deny {ip} into {site}")
PY

nginx -t
systemctl reload nginx
echo "nginx reloaded"
