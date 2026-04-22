#!/usr/bin/env bash
# Idempotently add "deny <ip>;" after each "server_name" line in the nginx site file
# so every server { ... } block (HTTP :80 redirects and HTTPS :443) enforces the block.
# Usage: sudo ./patch-nginx-deny-ip.sh 203.0.113.7
# Override path if your layout differs: sudo CHATAPP_NGINX_SITE_PATH=/etc/nginx/sites-available/chatapp ./patch-nginx-deny-ip.sh …
set -euo pipefail

# Default to sites-enabled: that is what nginx loads. On some hosts this is a
# symlink to sites-available (same inode); on others it is a divergent copy—
# patching only sites-available then does nothing.
SITE="${CHATAPP_NGINX_SITE_PATH:-/etc/nginx/sites-enabled/chatapp}"
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
deny_line_re = re.compile(rf"^\s*deny\s+{re.escape(ip)}\s*;", re.MULTILINE)
lines = site.read_text().splitlines(keepends=True)
out = []
inserted_any = False
for i, line in enumerate(lines):
    out.append(line)
    if not re.match(r"\s*server_name\s+", line):
        continue
    window = "".join(lines[i + 1 : i + 16])
    if deny_line_re.search(window):
        continue
    m = re.match(r"^(\s*)", line)
    ind = m.group(1) if m else "  "
    out.append(f"{ind}# Manual IP blocklist (patch-nginx-deny-ip.sh).\n")
    out.append(f"{ind}deny {ip};\n")
    inserted_any = True

if not inserted_any:
    print(f"deny {ip} already present after each server_name (or no server_name) — OK")
    sys.exit(0)

site.write_text("".join(out))
print(f"wrote deny {ip} into {site} (one or more server blocks)")
PY

nginx -t
systemctl reload nginx
echo "nginx reloaded"
