#!/usr/bin/env python3
"""Idempotent: add localhost-only stub_status on :18080 for nginx-prometheus-exporter."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

STUB_BLOCK = """# ChatApp: localhost-only stub_status for nginx-prometheus-exporter (patch-nginx-stub-status.py)
server {
    listen 127.0.0.1:18080;
    location = /stub_status {
        stub_status;
        access_log off;
    }
}

"""


def _site_paths_to_update(primary: Path) -> list[Path]:
    """When sites-available and sites-enabled are separate files, nginx loads enabled — patch both."""
    out = [primary]
    if primary.name != "chatapp":
        return out
    if "sites-available" not in str(primary):
        return out
    enabled = Path("/etc/nginx/sites-enabled/chatapp")
    if not enabled.is_file():
        return out
    try:
        if enabled.samefile(primary):
            return out
    except OSError:
        pass
    if enabled.stat().st_ino != primary.stat().st_ino:
        out.append(enabled)
    return out


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
        print("patch-nginx-stub-status: --site-path must be non-empty", file=sys.stderr)
        sys.exit(1)

    cfg = Path(site)
    if not cfg.is_file():
        print(f"9.076: skip — {site} missing")
        return

    targets = _site_paths_to_update(cfg)
    changed_any = False
    for path in targets:
        text = path.read_text(encoding="utf-8", errors="replace")
        if re.search(r"listen\s+127\.0\.0\.1:18080\b", text):
            print(f"9.076: stub already present in {path}")
            continue
        new_text = STUB_BLOCK + text
        fd, tmp = tempfile.mkstemp(prefix="nginx-stub-", suffix=".conf", dir="/tmp")
        os.close(fd)
        try:
            Path(tmp).write_text(new_text, encoding="utf-8")
            subprocess.run(["install", "-m", "644", tmp, str(path)], check=True)
        finally:
            Path(tmp).unlink(missing_ok=True)
        print(f"9.076: prepended stub_status server in {path}")
        changed_any = True

    if not changed_any:
        print("9.076: stub_status bind server already present (all targets)")
        return

    subprocess.run(["nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    print("9.076: nginx reloaded")


if __name__ == "__main__":
    main()
