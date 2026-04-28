#!/usr/bin/env python3
"""
On a host with redis-cli + /opt/chatapp/shared/.env (e.g. prod VM1):
  python3 scripts/redis-memory-pattern-audit.py

Reads REDIS_URL from ENV_PATH (default /opt/chatapp/shared/.env), never prints credentials.
"""
from __future__ import annotations

import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

ENV_PATH = Path(os.environ.get("ENV_PATH", "/opt/chatapp/shared/.env"))
SAMPLE_CAP = int(os.environ.get("AUDIT_SAMPLE_CAP", "400"))
MAX_KEYS_PER_PATTERN = int(os.environ.get("AUDIT_MAX_KEYS_PER_PATTERN", "200000"))


def load_redis_url() -> str:
    p = ENV_PATH
    if not p.is_file():
        raise SystemExit(f"missing {p}")
    for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.lower().startswith("export "):
            s = s[7:].strip()
        if s.startswith("REDIS_URL="):
            v = s.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            return v
    raise SystemExit("REDIS_URL not found in env file")


def redis_cli_base() -> tuple[list[str], dict[str, str]]:
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
    return cmd, env


def rc(cmd: list[str], env: dict[str, str], *args: str) -> str:
    return subprocess.check_output(cmd + list(args), env=env, text=True, stderr=subprocess.STDOUT)


def audit_pattern(cmd: list[str], env: dict[str, str], pattern: str) -> dict:
    sizes: list[int] = []
    ttl_neg1 = ttl_neg2 = 0
    pos_ttls: list[int] = []
    count = 0
    truncated = False
    proc = subprocess.Popen(
        cmd + ["--scan", "--pattern", pattern],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert proc.stdout is not None
    try:
        for key in proc.stdout:
            key = key.rstrip("\n")
            if not key:
                continue
            count += 1
            if count <= SAMPLE_CAP:
                try:
                    mu = int(rc(cmd, env, "MEMORY", "USAGE", key).strip())
                    sizes.append(mu)
                except (subprocess.CalledProcessError, ValueError):
                    pass
                try:
                    t = int(rc(cmd, env, "TTL", key).strip())
                    if t == -1:
                        ttl_neg1 += 1
                    elif t == -2:
                        ttl_neg2 += 1
                    elif t > 0:
                        pos_ttls.append(t)
                except (subprocess.CalledProcessError, ValueError):
                    pass
            if count >= MAX_KEYS_PER_PATTERN:
                proc.terminate()
                truncated = True
                break
    finally:
        if proc.stdout:
            proc.stdout.close()
        try:
            proc.wait(timeout=120)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    avg = statistics.mean(sizes) if sizes else 0.0
    p95 = statistics.quantiles(sizes, n=20)[18] if len(sizes) >= 20 else (max(sizes) if sizes else 0)
    est = int(avg * count) if count and sizes else 0
    return {
        "pattern": pattern,
        "count": count,
        "truncated": truncated,
        "sample_mem_n": len(sizes),
        "avg_mem": round(avg, 1),
        "p95_mem": int(p95),
        "est_total_bytes": est,
        "ttl_no_expire": ttl_neg1,
        "ttl_missing": ttl_neg2,
        "avg_ttl_pos": round(statistics.mean(pos_ttls), 1) if pos_ttls else None,
    }


def main() -> None:
    cmd, env = redis_cli_base()
    print("=== INFO memory ===")
    print(rc(cmd, env, "INFO", "memory"))
    print("=== INFO keyspace ===")
    print(rc(cmd, env, "INFO", "keyspace"))
    print("=== MEMORY STATS ===")
    print(rc(cmd, env, "MEMORY", "STATS"))
    print("=== MEMORY DOCTOR ===")
    print(rc(cmd, env, "MEMORY", "DOCTOR"))
    print("=== CONFIG maxmemory / policy ===")
    print(rc(cmd, env, "CONFIG", "GET", "maxmemory"))
    print(rc(cmd, env, "CONFIG", "GET", "maxmemory-policy"))
    print("=== INFO stats (evicted/expired/ops) ===")
    for line in rc(cmd, env, "INFO", "stats").splitlines():
        if any(
            x in line
            for x in (
                "evicted_keys",
                "expired_keys",
                "total_commands_processed",
                "instantaneous_ops_per_sec",
                "keyspace_hits",
                "keyspace_misses",
            )
        ):
            print(line)

    # Avoid `fanout:*` — it matches millions of `fanout:v1:done:*` / lock keys and scans for hours.
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

    t0 = time.time()
    rows = []
    for pat in patterns:
        print(f"\n=== SCAN pattern {pat!r} (sample up to {SAMPLE_CAP} keys for MEMORY/TTL) ===", flush=True)
        try:
            rows.append(audit_pattern(cmd, env, pat))
        except Exception as e:
            print(f"ERR {pat}: {e}", file=sys.stderr)
            rows.append({"pattern": pat, "count": -1, "error": str(e)})

    print("\n=== EXACT fanout queue keys (TYPE / LLEN / MEMORY / TTL) ===", flush=True)
    for qk in ("fanout:critical", "fanout:background"):
        try:
            typ = rc(cmd, env, "TYPE", qk).strip()
            n = rc(cmd, env, "LLEN", qk).strip() if typ == "list" else "n/a"
            mu = rc(cmd, env, "MEMORY", "USAGE", qk).strip()
            ttl = rc(cmd, env, "TTL", qk).strip()
            print(f"{qk}\tTYPE={typ}\tLLEN={n}\tMEMORY_USAGE={mu}\tTTL={ttl}")
        except subprocess.CalledProcessError as e:
            print(f"{qk}\tERR\t{e}")

    print("\n=== PATTERN SUMMARY (est_total = avg_mem * count; sampled avg) ===")
    print(
        "pattern\ttrunc\tcount\tsample_n\tavg_mem\tp95_mem\test_bytes\tttl_-1\tttl_-2\tavg_ttl+"
    )
    for r in rows:
        if r.get("count", 0) < 0:
            print(f"{r.get('pattern')}\tERR\t{r.get('error')}")
            continue
        at = r.get("avg_ttl_pos")
        ats = "" if at is None else str(at)
        tr = "Y" if r.get("truncated") else "N"
        print(
            f"{r['pattern']}\t{tr}\t{r['count']}\t{r['sample_mem_n']}\t{r['avg_mem']}\t{r['p95_mem']}\t{r['est_total_bytes']}\t{r['ttl_no_expire']}\t{r['ttl_missing']}\t{ats}"
        )
    print(f"\n=== audit wall seconds: {time.time() - t0:.1f} ===")


if __name__ == "__main__":
    main()
