#!/usr/bin/env python3
"""
30-minute Redis memory + pending-replay soak: Prometheus samples + capped fanout key count on VM1.

Env:
  PROMETHEUS_URL   default http://127.0.0.1:9092
  REDIS_SSH        default ubuntu@130.245.136.44
  REDIS_SCAN_LUA   remote path to redis-scan-count-cap.lua (default /tmp/redis-scan-count-cap.lua)
  ROUNDS           default 30
  INTERVAL_SEC     default 60
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def prom_instant(base: str, query: str) -> list[dict]:
    url = base.rstrip("/") + "/api/v1/query?query=" + urllib.parse.quote(query, safe="")
    with urllib.request.urlopen(url, timeout=25) as r:
        data = json.load(r)
    return data.get("data", {}).get("result", [])


def scalar(result: list[dict]) -> float | None:
    if not result:
        return None
    v = result[0].get("value", [None, None])[1]
    if v is None:
        return None
    try:
        x = float(v)
        if math.isnan(x):
            return None
        return x
    except ValueError:
        return None


def fanout_done_sample(ssh_host: str, lua_path: str) -> str:
    """Run capped SCAN on the SSH target using REDIS_URL from /opt/chatapp/shared/.env."""
    lua_js = json.dumps(lua_path)
    remote = f"""import os, subprocess
from urllib.parse import urlparse, unquote
lua = {lua_js}
u = None
for ln in open('/opt/chatapp/shared/.env'):
    if ln.startswith('REDIS_URL='):
        v = ln.split('=', 1)[1].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        u = urlparse(v)
        break
if not u:
    raise SystemExit('no REDIS_URL')
env = os.environ.copy()
if u.password:
    env['REDISCLI_AUTH'] = unquote(u.password)
cmd = ['redis-cli', '-h', u.hostname or '127.0.0.1', '-p', str(u.port or 6379)]
if u.username:
    cmd += ['--user', unquote(u.username)]
out = subprocess.check_output(
    cmd + ['--eval', lua, ',', 'fanout:v1:done:*', '200000'],
    text=True,
    env=env,
).strip()
print(out)
"""
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", ssh_host, "python3", "-"],
            input=remote,
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=120,
        ).strip()
        return out
    except subprocess.CalledProcessError:
        return "ERR"
    except subprocess.TimeoutExpired:
        return "TIMEOUT"


def main() -> None:
    prom = os.environ.get("PROMETHEUS_URL", "http://127.0.0.1:9092")
    ssh_host = os.environ.get("REDIS_SSH", "ubuntu@130.245.136.44")
    lua = os.environ.get("REDIS_SCAN_LUA", "/tmp/redis-scan-count-cap.lua")
    rounds = int(os.environ.get("ROUNDS", "30"))
    interval = int(os.environ.get("INTERVAL_SEC", "60"))
    win = os.environ.get("SOAK_WINDOW", "32m")

    max_mem_pct = 0.0
    max_evict = 0.0
    max_expired = 0.0
    max_trim = 0.0
    max_guard = 0.0
    max_z95: float | None = None
    max_z99: float | None = None
    zset_samples = 0
    guard_positive_samples = 0

    print(f"soak_start={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} prom={prom} ssh={ssh_host} rounds={rounds} interval_s={interval}")

    for i in range(1, rounds + 1):
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        used = scalar(prom_instant(prom, 'max(redis_memory_used_bytes{job="redis"})'))
        maxb = scalar(prom_instant(prom, 'max(redis_memory_max_bytes{job="redis"})'))
        if maxb is None or maxb <= 0:
            maxb = scalar(prom_instant(prom, 'max(redis_config_maxmemory{job="redis"})'))

        mem_pct = (100.0 * used / maxb) if (used is not None and maxb and maxb > 0) else float("nan")

        ev = scalar(prom_instant(prom, 'sum(rate(redis_evicted_keys_total{job="redis"}[2m]))'))
        ex = scalar(prom_instant(prom, 'sum(rate(redis_expired_keys_total{job="redis"}[2m]))'))
        tr = scalar(
            prom_instant(prom, 'sum(rate(ws_pending_replay_user_trimmed_total{job="chatapp-api"}[2m]))'),
        )
        gu = scalar(prom_instant(prom, 'sum(rate(ws_pending_replay_guard_total{job="chatapp-api"}[2m]))'))
        z95 = scalar(
            prom_instant(
                prom,
                'histogram_quantile(0.95, sum by (le) (rate(ws_pending_replay_user_zset_size_bucket{job="chatapp-api"}[2m])))',
            ),
        )
        z99 = scalar(
            prom_instant(
                prom,
                'histogram_quantile(0.99, sum by (le) (rate(ws_pending_replay_user_zset_size_bucket{job="chatapp-api"}[2m])))',
            ),
        )
        fd = fanout_done_sample(ssh_host, lua)

        if not math.isnan(mem_pct):
            max_mem_pct = max(max_mem_pct, mem_pct)
        if ev is not None:
            max_evict = max(max_evict, ev)
        if ex is not None:
            max_expired = max(max_expired, ex)
        if tr is not None:
            max_trim = max(max_trim, tr)
        if gu is not None:
            max_guard = max(max_guard, gu)
            if gu > 1e-9:
                guard_positive_samples += 1
        if z95 is not None or z99 is not None:
            zset_samples += 1
        if z95 is not None:
            max_z95 = z95 if max_z95 is None else max(max_z95, z95)
        if z99 is not None:
            max_z99 = z99 if max_z99 is None else max(max_z99, z99)

        print(
            f"i={i} ts={ts} mem_pct={mem_pct:.4f} evict_per_s={ev} expired_per_s={ex} "
            f"trim_per_s={tr} guard_per_s={gu} zset_p95={z95} zset_p99={z99} fanout_done_cap={fd}",
            flush=True,
        )

        if i < rounds:
            time.sleep(interval)

    print(f"soak_end={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    print(
        f"summary max_mem_pct={max_mem_pct:.4f} max_evict_rate_per_s={max_evict:.8g} "
        f"max_expired_rate_per_s={max_expired:.8g} max_trim_rate_per_s={max_trim:.8g} "
        f"max_guard_rate_per_s={max_guard:.8g} max_zset_p95={max_z95} max_zset_p99={max_z99} "
        f"zset_histogram_samples={zset_samples} "
        f"guard_positive_samples={guard_positive_samples}",
        flush=True,
    )

    def win_inc(expr: str) -> float | None:
        q = expr.replace("__W__", win)
        return scalar(prom_instant(prom, q))

    print(f"--- window totals [{win}] ---", flush=True)
    for label, expr in [
        ("ws_pending_replay_guard_inc", 'sum(increase(ws_pending_replay_guard_total{job="chatapp-api"}[__W__]))'),
        ("ws_pending_replay_trimmed_inc", 'sum(increase(ws_pending_replay_user_trimmed_total{job="chatapp-api"}[__W__]))'),
        ("redis_evicted_keys_inc", 'sum(increase(redis_evicted_keys_total{job="redis"}[__W__]))'),
        ("redis_expired_keys_inc", 'sum(increase(redis_expired_keys_total{job="redis"}[__W__]))'),
    ]:
        v = win_inc(expr)
        print(f"{label}={v}", flush=True)

    print(f"fanout_done_end_sample={fanout_done_sample(ssh_host, lua)}", flush=True)

    mem_safe = max_mem_pct < 85.0 if max_mem_pct > 0 else False
    evict_ok = max_evict <= 1e-9
    # Bounded if we saw histogram samples and tail stayed below top bucket (5000 in metrics.ts).
    if max_z99 is not None:
        pending_bounded = max_z99 < 5000.0
    elif max_z95 is not None:
        pending_bounded = max_z95 < 5000.0
    else:
        pending_bounded = False
    guard_ok = guard_positive_samples == 0 and max_guard <= 1e-9

    print("--- verdict ---", flush=True)
    print(f"memory_safe={'YES' if mem_safe else 'NO'} (max {max_mem_pct:.2f}% < 85%)", flush=True)
    print(f"evictions_zero={'YES' if evict_ok else 'NO'} (max rate {max_evict})", flush=True)
    print(
        f"pending_replay_bounded={'YES' if pending_bounded else 'NO'} "
        f"(rounds_with_zset_hist={zset_samples} max_p95={max_z95} max_p99={max_z99})",
        flush=True,
    )
    print(
        f"guard_activated={'NO' if guard_ok else 'YES'} (positive samples {guard_positive_samples}, max rate {max_guard})",
        flush=True,
    )
    # Expiry is normal Redis hygiene; not a failure. Permanent fix: hardening + TTL caps — sufficient if memory+evict OK.
    perm = mem_safe and evict_ok
    print(f"permanent_fix_sufficient={'YES' if perm else 'NO'} (memory+evictions only; see soak logs for trim/guard)", flush=True)


if __name__ == "__main__":
    main()
