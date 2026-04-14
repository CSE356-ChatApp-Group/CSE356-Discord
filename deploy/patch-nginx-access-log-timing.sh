#!/usr/bin/env bash
# Idempotently extend the main nginx access log with request + upstream timing.
# Adds log_format chatapp_timed and points access_log /var/log/nginx/access.log at it.
# Analyzers that regex only through HTTP status (analyze-nginx-grader-traffic.py, etc.)
# remain valid because timing fields are appended after the combined-log tail.
#
# Run on the server with sudo (deploy copies this to /tmp and executes).
set -euo pipefail

CFG=/etc/nginx/nginx.conf
[[ -f "$CFG" ]] || { echo "ERROR: missing ${CFG}"; exit 1; }

python3 <<'PY'
from pathlib import Path
import re
import sys
import tempfile

cfg = Path("/etc/nginx/nginx.conf")
text = orig = cfg.read_text(encoding="utf-8", errors="replace")

if "log_format chatapp_timed" not in text:
    fmt = """    log_format chatapp_timed '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" '
                    'rt=$request_time urt=$upstream_response_time';
"""
    m = re.search(r"http\s*\{", text)
    if not m:
        print("ERROR: no http { block in nginx.conf", file=sys.stderr)
        sys.exit(1)
    text = text[: m.end()] + "\n" + fmt + text[m.end() :]

def retarget_access_log(body: str) -> tuple[str, int]:
    def repl(m: re.Match[str]) -> str:
        return f"{m.group(1)} chatapp_timed;"

    return re.subn(
        r"(access_log\s+/var/log/nginx/access\.log)\s*[^;]*;",
        repl,
        body,
        count=1,
    )

text2, n = retarget_access_log(text)
if n != 1:
    print(
        "ERROR: expected exactly one access_log /var/log/nginx/access.log line in "
        f"{cfg} (matched {n}).",
        file=sys.stderr,
    )
    sys.exit(1)

if text2 == orig:
    print("nginx: already configured (chatapp_timed + access_log)")
else:
    import os

    fd, tmp_path = tempfile.mkstemp(prefix=".nginx-conf-", dir=str(cfg.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(text2)
        os.replace(tmp_path, str(cfg))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
    print("nginx: wrote updated", cfg)
PY

nginx -t
systemctl reload nginx
echo "nginx: timing fields enabled (nginx -t OK, reloaded)"
