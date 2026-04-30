#!/usr/bin/env python3
"""Capped SCAN counts per pattern (prod VM1). ENV_PATH=/opt/chatapp/shared/.env"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ENV_PATH = Path(os.environ.get("ENV_PATH", "/opt/chatapp/shared/.env"))
CAP = int(os.environ.get("SCAN_CAP", "50000"))


def load_redis_url() -> str:
    for raw in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if s.startswith("REDIS_URL="):
            v = s.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            return v
    raise SystemExit("REDIS_URL missing")


def main() -> None:
    raw = load_redis_url()
    u = urlparse(raw)
    host = u.hostname or "127.0.0.1"
    port = u.port or 6379
    user = unquote(u.username) if u.username else ""
    pw = unquote(u.password) if u.password else ""
    env = os.environ.copy()
    if pw:
        env["REDISCLI_AUTH"] = pw
    cmd = ["redis-cli", "-h", host, "-p", str(port)]
    if user:
        cmd.extend(["--user", user])

    patterns = [
        "ws:pending:message:*",
        "ws:pending:user:*",
        "fanout:v1:done:*",
        "fanout:v1:lock:*",
        "fanout:background.*",
        "channel:*:user_fanout_targets",
        "channel:recent_connect:*",
        "ws:recent_connect:*",
        "stale:*",
        "community:*:members",
        "communities:list:*",
        "presence:*:fanout_targets",
        "channel:msg_count:*",
        "community:counts",
        "ch:last_msg:*",
        "conv:last_msg:*",
    ]

    for pat in patterns:
        n = 0
        proc = subprocess.Popen(
            cmd + ["--scan", "--pattern", pat],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        assert proc.stdout is not None
        for _ in proc.stdout:
            n += 1
            if n >= CAP:
                break
        proc.stdout.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        tag = f">={CAP}" if n >= CAP else str(n)
        print(f"{pat}\t{tag}", flush=True)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
    sys.exit(0)
