#!/usr/bin/env python3
"""Idempotent: insert ^~ /api/v1/auth/ with extended timeouts before generic /api/."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--site-path", required=True, help="Path to nginx site config")
    args = p.parse_args()
    site = (args.site_path or "").strip()
    if not site:
        print("patch-nginx-auth-location: --site-path must be non-empty", file=sys.stderr)
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.07: skip — {site} missing")
        return

    text = cfg.read_text(encoding="utf-8", errors="replace")
    if re.search(r"location\s+\^~\s+/api/v1/auth/", text):
        print("9.07: auth location already present")
        return

    needle = "  location /api/ {"
    block = """  location ^~ /api/v1/auth/ {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;
    proxy_next_upstream_tries 0;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    client_max_body_size 10m;
  }

"""
    if needle not in text:
        raise SystemExit('9.07: could not find "  location /api/ {" — patch nginx manually')

    new_text = text.replace(needle, block + needle, 1)
    fd, tmp = tempfile.mkstemp(prefix="nginx-auth-loc-", suffix=".conf", dir="/tmp")
    os.close(fd)
    try:
        Path(tmp).write_text(new_text, encoding="utf-8")
        subprocess.run(["install", "-m", "644", tmp, str(cfg)], check=True)
    finally:
        Path(tmp).unlink(missing_ok=True)

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.07: inserted auth location + reloaded nginx")


if __name__ == "__main__":
    main()
