#!/usr/bin/env python3
"""Idempotent: ensure generic ^~ /api/v1/auth/ uses canonical proxy_next_upstream (non_idempotent)."""

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
    p.add_argument(
        "--retry-full",
        required=True,
        help="Canonical proxy_next_upstream line (with non_idempotent)",
    )
    p.add_argument(
        "--retry-legacy",
        required=True,
        help="Legacy proxy_next_upstream substring to replace if present",
    )
    args = p.parse_args()
    site = (args.site_path or "").strip()
    retry_full = (args.retry_full or "").strip()
    retry_legacy = (args.retry_legacy or "").strip()
    if not site or not retry_full or not retry_legacy:
        print(
            "patch-nginx-auth-non-idempotent: --site-path, --retry-full, --retry-legacy required",
            file=sys.stderr,
        )
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.075: skip — {site} missing")
        return

    text = cfg.read_text(encoding="utf-8", errors="replace")
    pat = re.compile(r"(location\s+\^~\s+/api/v1/auth/\s*\{)(.*?)(\n\s*\})", re.DOTALL)
    m = pat.search(text)
    if not m:
        print("9.075: skip (no auth block or already patched)")
        return

    body = m.group(2)
    orig = body
    body = re.sub(r"\n\s*proxy_next_upstream_non_idempotent\s+on;\s*", "\n", body)
    if retry_legacy in body:
        body = body.replace(retry_legacy, retry_full, 1)
    elif retry_full in body:
        print("9.075: skip (no auth block or already patched)")
        return
    else:
        print("9.075: skip (no auth block or already patched)")
        return

    if body == orig:
        print("9.075: skip (no auth block or already patched)")
        return

    new_text = text[: m.start()] + m.group(1) + body + m.group(3) + text[m.end() :]
    fd, tmp = tempfile.mkstemp(prefix="nginx-auth-ni-", suffix=".conf", dir="/tmp")
    os.close(fd)
    try:
        Path(tmp).write_text(new_text, encoding="utf-8")
        subprocess.run(["install", "-m", "644", tmp, str(cfg)], check=True)
    finally:
        Path(tmp).unlink(missing_ok=True)

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.075: patched auth proxy_next_upstream (non_idempotent) + reloaded nginx")


if __name__ == "__main__":
    main()
