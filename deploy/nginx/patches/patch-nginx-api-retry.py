#!/usr/bin/env python3
"""Idempotent: normalize proxy_next_upstream + proxy_next_upstream_tries inside location /api/."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


def _api_retry_policy_complete(text: str) -> bool:
    """Mirror deploy awk: every location /api/ { ... } block has canonical retry + tries 0."""
    in_api = False
    seen_api = 0
    retry = False
    tries = False
    all_ok = True
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.search(r"location\s+/api/\s*\{", line):
            in_api = True
            seen_api += 1
            retry = tries = False
            i += 1
            continue
        if in_api and re.match(r"^\s*}", line):
            if not (retry and tries):
                all_ok = False
            in_api = False
            i += 1
            continue
        if in_api:
            if re.search(
                r"proxy_next_upstream\s+error\s+timeout\s+http_502\s+http_503\s+http_504\s+non_idempotent;",
                line,
            ):
                retry = True
            if re.search(r"proxy_next_upstream_tries\s+0;", line):
                tries = True
        i += 1
    if in_api and not (retry and tries):
        all_ok = False
    return seen_api > 0 and all_ok


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--site-path", required=True, help="Path to nginx site config")
    p.add_argument(
        "--retry-line",
        required=True,
        help="Full proxy_next_upstream line including trailing semicolon",
    )
    args = p.parse_args()
    site = (args.site_path or "").strip()
    retry_full = (args.retry_line or "").strip()
    if not site or not retry_full:
        print("patch-nginx-api-retry: --site-path and --retry-line required", file=sys.stderr)
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.06: skip — {site} missing")
        return

    text = cfg.read_text(encoding="utf-8", errors="replace")
    if _api_retry_policy_complete(text):
        print("9.06: /api retry + non-idempotent POST policy already present")
        return

    pattern = re.compile(r"(location\s+/api/\s*\{)(.*?)(\n\s*\})", re.DOTALL)
    found = False
    changed = False

    def normalize_api_block(match: re.Match[str]) -> str:
        nonlocal found, changed
        found = True
        body = match.group(2)
        orig = body
        body = re.sub(r"\n\s*proxy_next_upstream_non_idempotent\s+on;\s*", "\n", body)
        body = re.sub(r"\n\s*proxy_next_upstream[^\n]*;", "", body)
        body = re.sub(r"\n\s*proxy_next_upstream_tries\s+\d+;", "", body)
        body += f"\n    {retry_full}\n    proxy_next_upstream_tries 0;"
        if body != orig:
            changed = True
        return match.group(1) + body + match.group(3)

    new_text = pattern.sub(normalize_api_block, text)
    if not found:
        print("9.06: /api location block not found", file=sys.stderr)
        sys.exit(1)
    if not changed:
        print("9.06: /api block already complete (race with parallel check); skipping reload")
        return

    fd, tmp = tempfile.mkstemp(prefix="nginx-api-retry-", suffix=".conf", dir="/tmp")
    os.close(fd)
    try:
        Path(tmp).write_text(new_text, encoding="utf-8")
        subprocess.run(["install", "-m", "644", tmp, str(cfg)], check=True)
    finally:
        Path(tmp).unlink(missing_ok=True)

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.06: updated /api upstream retry policy (proxy_next_upstream … non_idempotent) + reloaded nginx")


if __name__ == "__main__":
    main()
