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

def has_log_format_anywhere(name: str) -> bool:
    import subprocess

    try:
        result = subprocess.run(
            ["grep", "-Rsl", f"log_format {name}", "/etc/nginx"],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False

has_timed = "log_format chatapp_timed" in text or has_log_format_anywhere("chatapp_timed")
has_ws = "log_format chatapp_ws" in text or has_log_format_anywhere("chatapp_ws")

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

def ensure_ws_access_log(body: str) -> str:
    # The /ws location block may live in a separate sites-available file rather
    # than in nginx.conf itself (staging and prod both deploy it via staging.conf /
    # chatapp-nginx-*.conf).  Check the canonical sites file first; if the
    # ws_access.log directive is already present anywhere in the nginx config
    # tree we can skip the nginx.conf patch entirely.
    import subprocess
    try:
        result = subprocess.run(
            ["sudo", "grep", "-rl", "ws_access.log", "/etc/nginx/"],
            capture_output=True, text=True
        )
        if result.returncode == 0 and result.stdout.strip():
            # Already configured in some included file — nothing to do.
            return body
    except Exception:
        pass

    pattern = re.compile(r"(location\s+/ws\s*\{)([^}]*)(\})", re.DOTALL)
    m = pattern.search(body)
    if not m:
        # /ws block is not in nginx.conf — it lives in a sites file that is
        # deployed separately (staging.conf / chatapp-nginx.conf).  If we
        # reached here the ws_access.log line is not anywhere yet; add it to
        # the sites file if it exists, otherwise skip silently.
        sites_candidates = [
            "/etc/nginx/sites-available/chatapp",
            "/etc/nginx/sites-enabled/chatapp",
        ]
        for sites_path in sites_candidates:
            try:
                sites_text = Path(sites_path).read_text(encoding="utf-8", errors="replace")
                sm = pattern.search(sites_text)
                if sm:
                    if "/var/log/nginx/ws_access.log chatapp_ws;" in sm.group(2):
                        return body  # already there
                    head, inner, tail = sm.groups()
                    insertion = "\n            access_log         /var/log/nginx/ws_access.log chatapp_ws;"
                    replaced = f"{head}{insertion}{inner}{tail}"
                    new_sites = sites_text[:sm.start()] + replaced + sites_text[sm.end():]
                    import os, tempfile
                    fd, tmp = tempfile.mkstemp(prefix=".nginx-sites-", dir="/etc/nginx/sites-available")
                    try:
                        with os.fdopen(fd, "w", encoding="utf-8") as fh:
                            fh.write(new_sites)
                        os.replace(tmp, sites_path)
                    finally:
                        if os.path.exists(tmp):
                            os.unlink(tmp)
                    print(f"nginx: added ws_access.log to {sites_path}")
                    return body
            except FileNotFoundError:
                continue
        print("nginx: no /ws location block found — skipping ws_access.log setup")
        return body
    head, inner, tail = m.groups()
    if "/var/log/nginx/ws_access.log chatapp_ws;" in inner:
        return body
    insertion = "\n            access_log         /var/log/nginx/ws_access.log chatapp_ws;"
    replaced = f"{head}{insertion}{inner}{tail}"
    return body[:m.start()] + replaced + body[m.end():]

text3 = ensure_ws_access_log(text2)

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
