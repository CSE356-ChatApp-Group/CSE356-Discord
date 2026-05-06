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

has_timed = "log_format chatapp_timed" in text
has_ws = "log_format chatapp_ws" in text

if not has_timed or not has_ws:
    formats_to_add = []
    if not has_timed:
        formats_to_add.append(
            """    log_format chatapp_timed '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" '
                    'rt=$request_time urt=$upstream_response_time';"""
        )
    if not has_ws:
        formats_to_add.append(
            """    log_format chatapp_ws '$remote_addr - $remote_user [$time_local] "$request" '
                          '$status $body_bytes_sent rt=$request_time urt=$upstream_response_time '
                          'uaddr=$upstream_addr ustatus=$upstream_status rid=$request_id '
                          'upgrade="$http_upgrade" connection="$http_connection" '
                          'xff="$http_x_forwarded_for" ua="$http_user_agent"';"""
        )
    fmt = "\n".join(formats_to_add) + "\n"
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

def desired_ws_upstream(body: str) -> str | None:
    if "upstream app_ws {" in body:
        return "app_ws"
    if "upstream chatapp_ws_upstream {" in body:
        return "chatapp_ws_upstream"
    if "upstream ws_nodes {" in body:
        return "ws_nodes"
    return None

def patch_ws_block(body: str) -> tuple[str, bool]:
    pattern = re.compile(r"(location\s+/ws\s*\{)([^}]*)(\})", re.DOTALL)
    m = pattern.search(body)
    if not m:
        return body, False
    head, inner, tail = m.groups()
    new_inner = inner
    changed = False
    if "/var/log/nginx/ws_access.log chatapp_ws;" not in new_inner:
        insertion = "\n    access_log /var/log/nginx/ws_access.log chatapp_ws;"
        new_inner = insertion + new_inner
        changed = True
    desired = desired_ws_upstream(body)
    if desired:
        updated_inner, n_proxy = re.subn(
            r"proxy_pass\s+http://[^;]+;",
            f"proxy_pass http://{desired};",
            new_inner,
            count=1,
        )
        if n_proxy == 1 and updated_inner != new_inner:
            new_inner = updated_inner
            changed = True
    if not changed:
        return body, False
    replaced = f"{head}{new_inner}{tail}"
    return body[:m.start()] + replaced + body[m.end():], True

text3, changed_main_ws = patch_ws_block(text2)

sites_candidates = [
    Path("/etc/nginx/sites-available/chatapp"),
    Path("/etc/nginx/sites-enabled/chatapp"),
]
patched_any_site = False
for sites_path in sites_candidates:
    try:
        sites_text = sites_path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        continue
    new_sites_text, changed = patch_ws_block(sites_text)
    if not changed:
        continue
    import os
    fd, tmp = tempfile.mkstemp(prefix=".nginx-sites-", dir=str(sites_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(new_sites_text)
        os.replace(tmp, sites_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(f"nginx: patched /ws location in {sites_path}")
    patched_any_site = True

if not changed_main_ws and not patched_any_site and "location /ws" not in text2:
    print("nginx: no /ws location block found — skipping websocket route patch")

if text3 == orig:
    print("nginx: already configured (chatapp_timed + chatapp_ws logs)")
else:
    import os

    fd, tmp_path = tempfile.mkstemp(prefix=".nginx-conf-", dir=str(cfg.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(text3)
        os.replace(tmp_path, str(cfg))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
    print("nginx: wrote updated", cfg)
PY

nginx -t
systemctl reload nginx
echo "nginx: timing fields enabled (nginx -t OK, reloaded)"
