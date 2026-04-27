#!/usr/bin/env python3
"""Emit Redis URL for redis_exporter from /opt/chatapp/shared/.env (stdout, one line)."""
from __future__ import annotations

from pathlib import Path

DEFAULT = "redis://127.0.0.1:6379"
ENV_PATH = Path("/opt/chatapp/shared/.env")


def main() -> None:
    if not ENV_PATH.is_file():
        print(DEFAULT)
        return
    for raw in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.lower().startswith("export "):
            s = s[7:].strip()
        if s.startswith("REDIS_URL="):
            v = s.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
                v = v[1:-1]
            print(v or DEFAULT)
            return
    print(DEFAULT)


if __name__ == "__main__":
    main()
