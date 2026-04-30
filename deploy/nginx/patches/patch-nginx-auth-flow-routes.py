#!/usr/bin/env python3
"""Idempotent: critical OAuth/auth flow routes before generic ^~ /api/v1/auth/ block."""

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
        print("patch-nginx-auth-flow-routes: --site-path must be non-empty", file=sys.stderr)
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.071: skip — {site} missing")
        return

    text = cfg.read_text(encoding="utf-8", errors="replace")
    needles = [
        r"location\s+\^~\s+/api/v1/auth/course/callback",
        r"location\s+\^~\s+/api/v1/auth/course",
        r"location\s+\^~\s+/api/v1/auth/oauth/complete-create",
        r"location\s+\^~\s+/api/v1/auth/login",
        r"location\s+\^~\s+/api/v1/auth/register",
    ]
    if all(re.search(pattern, text) for pattern in needles):
        return

    needle = "  location ^~ /api/v1/auth/ {"
    block = """  location ^~ /api/v1/auth/course/callback {
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

  location ^~ /api/v1/auth/course {
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

  location ^~ /api/v1/auth/oauth/complete-create {
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

  location ^~ /api/v1/auth/login {
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

  location ^~ /api/v1/auth/register {
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
        raise SystemExit("9.071: could not find critical auth insertion point")

    new_text = text.replace(needle, block + needle, 1)
    fd, tmp = tempfile.mkstemp(prefix="nginx-auth-flow-", suffix=".conf", dir="/tmp")
    os.close(fd)
    try:
        Path(tmp).write_text(new_text, encoding="utf-8")
        subprocess.run(["install", "-m", "644", tmp, str(cfg)], check=True)
    finally:
        Path(tmp).unlink(missing_ok=True)

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.071: inserted critical auth flow routes + reloaded nginx")


if __name__ == "__main__":
    main()
