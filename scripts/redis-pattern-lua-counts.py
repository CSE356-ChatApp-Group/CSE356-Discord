#!/usr/bin/env python3
"""Count keys matching glob with early cap (server-side Lua SCAN). ENV_PATH default prod .env."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ENV_PATH = Path(os.environ.get("ENV_PATH", "/opt/chatapp/shared/.env"))
CAP = int(os.environ.get("SCAN_CAP", "200001"))
LUA = Path(os.environ.get("LUA_PATH", "/tmp/redis-scan-count-cap.lua"))


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
        try:
            out = subprocess.check_output(
                cmd + ["--eval", str(LUA), ",", pat, str(CAP)],
                env=env,
                text=True,
                stderr=subprocess.STDOUT,
                timeout=120,
            ).strip()
        except subprocess.TimeoutExpired:
            out = "TIMEOUT"
        except subprocess.CalledProcessError as e:
            out = f"ERR:{e.output.strip()[:200]}"
        print(f"{pat}\t{out}", flush=True)


if __name__ == "__main__":
    main()
