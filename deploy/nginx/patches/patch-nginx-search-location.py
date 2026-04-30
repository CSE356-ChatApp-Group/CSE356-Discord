#!/usr/bin/env python3
"""Idempotent: insert ^~ /api/v1/search with extended proxy timeouts before generic /api/."""

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
    p.add_argument(
        "--site-path",
        required=True,
        help="Path to nginx site config (e.g. /etc/nginx/sites-available/chatapp)",
    )
    args = p.parse_args()
    site = (args.site_path or "").strip()
    if not site:
        print("patch-nginx-search-location: --site-path must be non-empty", file=sys.stderr)
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.05: skip — {site} missing")
        return

    text = cfg.read_text(encoding="utf-8", errors="replace")
    if re.search(r"location\s+\^~\s+/api/v1/search", text):
        print("9.05: search location already present")
        return

    needle = "  location /api/ {"
    block = """  location ^~ /api/v1/search {
    proxy_pass http://app;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
    client_max_body_size 10m;
  }

"""
    if needle not in text:
        raise SystemExit('9.05: could not find "  location /api/ {" — patch nginx manually')

    new_text = text.replace(needle, block + needle, 1)
    fd, tmp = tempfile.mkstemp(prefix="nginx-search-", suffix=".conf", dir="/tmp")
    os.close(fd)
    try:
        Path(tmp).write_text(new_text, encoding="utf-8")
        subprocess.run(["install", "-m", "644", tmp, str(cfg)], check=True)
    finally:
        Path(tmp).unlink(missing_ok=True)

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.05: inserted search location + reloaded nginx")


if __name__ == "__main__":
    main()
