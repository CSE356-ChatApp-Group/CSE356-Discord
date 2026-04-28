#!/usr/bin/env python3
"""Sample MEMORY USAGE + TTL for first N keys of each glob (prod)."""
from __future__ import annotations

import os
import statistics
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

ENV_PATH = Path(os.environ.get("ENV_PATH", "/opt/chatapp/shared/.env"))
N = int(os.environ.get("SAMPLE_N", "250"))


def load_redis_url() -> str:
    for raw in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if s.startswith("REDIS_URL="):
            v = s.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            return v
    raise SystemExit("REDIS_URL missing")


def rc(cmd: list[str], env: dict[str, str], *a: str) -> str:
    return subprocess.check_output(cmd + list(a), env=env, text=True, stderr=subprocess.STDOUT)


def sample_pattern(cmd: list[str], env: dict[str, str], pattern: str) -> None:
    sizes: list[int] = []
    ttl_neg1 = ttl_neg2 = 0
    pos: list[int] = []
    proc = subprocess.Popen(
        cmd + ["--scan", "--pattern", pattern],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert proc.stdout is not None
    got = 0
    try:
        for line in proc.stdout:
            k = line.rstrip("\n")
            if not k:
                continue
            got += 1
            try:
                sizes.append(int(rc(cmd, env, "MEMORY", "USAGE", k).strip()))
            except (ValueError, subprocess.CalledProcessError):
                pass
            try:
                t = int(rc(cmd, env, "TTL", k).strip())
                if t == -1:
                    ttl_neg1 += 1
                elif t == -2:
                    ttl_neg2 += 1
                elif t > 0:
                    pos.append(t)
            except (ValueError, subprocess.CalledProcessError):
                pass
            if got >= N:
                break
    finally:
        if proc.stdout:
            proc.stdout.close()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    avg = statistics.mean(sizes) if sizes else 0.0
    p95 = statistics.quantiles(sizes, n=20)[18] if len(sizes) >= 20 else (max(sizes) if sizes else 0)
    print(
        f"{pattern}\tsampled={got}\tmem_n={len(sizes)}\tavgB={avg:.0f}\tp95B={int(p95)}\t"
        f"ttl_-1={ttl_neg1}\tttl_-2={ttl_neg2}\tavgTTL+={(statistics.mean(pos) if pos else 0):.0f}"
    )
    sys.stdout.flush()


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

    for qk in ("fanout:critical", "fanout:background"):
        try:
            typ = rc(cmd, env, "TYPE", qk).strip()
            ln = rc(cmd, env, "LLEN", qk).strip() if typ == "list" else "n/a"
            mu = rc(cmd, env, "MEMORY", "USAGE", qk).strip()
            print(f"{qk}\tTYPE={typ}\tLLEN={ln}\tMEM={mu}", flush=True)
        except subprocess.CalledProcessError as e:
            print(qk, "ERR", e, flush=True)

    for pat in [
        "fanout:v1:done:*",
        "ws:pending:user:*",
        "conv:last_msg:*",
        "communities:list:*",
        "channel:msg_count:*",
        "ch:last_msg:*",
        "ws:pending:message:*",
        "presence:*:fanout_targets",
        "channel:*:user_fanout_targets",
    ]:
        sample_pattern(cmd, env, pat)


if __name__ == "__main__":
    main()
