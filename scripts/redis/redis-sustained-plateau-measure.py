#!/usr/bin/env python3
"""
Sustained Redis plateau test: background VM1 steady POST load + per-minute Prometheus + fanout_done sample.

Env:
  PROMETHEUS_URL   default http://127.0.0.1:9092
  REDIS_SSH        default ubuntu@130.245.136.44 (VM1; redis-cli reaches managed Redis)
  LOAD_DURATION_SEC default 840  (14 min steady load)
  SAMPLE_INTERVAL_S default 60
  STEADY_CONCURRENCY default 30
  OUT              default var/redis-sustained-plateau-<utc>.jsonl
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
from datetime import datetime, timezone


def prom_scalar(base: str, query: str) -> float | None:
    url = base.rstrip("/") + "/api/v1/query?query=" + urllib.parse.quote(query, safe="")
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    res = data.get("data", {}).get("result", [])
    if not res:
        return None
    try:
        v = float(res[0]["value"][1])
        return None if math.isnan(v) else v
    except (ValueError, IndexError, KeyError):
        return None


def fanout_done_count(ssh_host: str, lua_remote: str) -> str | None:
    """Capped SCAN count fanout:v1:done:* via redis-cli on REDIS_SSH."""
    remote = r'''import os, subprocess
from urllib.parse import urlparse, unquote
lua = ''' + repr(lua_remote) + r'''
for ln in open('/opt/chatapp/shared/.env'):
    if ln.startswith('REDIS_URL='):
        v = ln.split('=', 1)[1].strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
            v = v[1:-1]
        u = urlparse(v)
        break
else:
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
'''
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=25", ssh_host, "python3", "-"],
            input=remote,
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=120,
        ).strip()
        return out
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None


def main() -> None:
    prom = os.environ.get("PROMETHEUS_URL", "http://127.0.0.1:9092")
    ssh = os.environ.get("REDIS_SSH", "ubuntu@130.245.136.44")
    load_sec = int(os.environ.get("LOAD_DURATION_SEC", "840"))
    interval = int(os.environ.get("SAMPLE_INTERVAL_S", "60"))
    conc = int(os.environ.get("STEADY_CONCURRENCY", "30"))
    lua = os.environ.get("REDIS_SCAN_LUA", "/tmp/redis-scan-count-cap.lua")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = os.environ.get("OUT", f"var/redis-sustained-plateau-{ts}.jsonl")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    rounds = max(5, load_sec // interval + 3)
    env = os.environ.copy()
    env["INSECURE_TLS"] = "1"
    env["BASE_URL"] = "https://127.0.0.1/api/v1"
    env["VERIFY"] = "0"
    env["STEADY_CONCURRENCY"] = str(conc)
    env["STEADY_DURATION_SEC"] = str(load_sec)

    print(f"start load ssh={ssh} duration_s={load_sec} concurrency={conc} -> {out_path}", flush=True)
    log = open(out_path, "w", encoding="utf-8")
    # Remote shell does not inherit the parent process env; export on the SSH command line.
    remote_cmd = (
        f"INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 VERIFY=0 "
        f"STEADY_CONCURRENCY={conc} STEADY_DURATION_SEC={load_sec} "
        f"node /tmp/prod-sustained-channel-post.mjs"
    )
    proc = subprocess.Popen(
        ["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", ssh, remote_cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    prev_trim = prev_guard = None
    mem_series: list[float] = []

    try:
        for i in range(rounds):
            if i > 0:
                time.sleep(interval)
            now = datetime.now(timezone.utc).isoformat()
            mem_pct = prom_scalar(
                prom,
                '100 * max(redis_memory_used_bytes{job="redis"}) / clamp_min(max(redis_memory_max_bytes{job="redis"}),1)',
            )
            ev_r = prom_scalar(prom, 'sum(rate(redis_expired_keys_total{job="redis"}[2m]))')
            evict_r = prom_scalar(prom, 'sum(rate(redis_evicted_keys_total{job="redis"}[2m]))')
            delivery_r = prom_scalar(
                prom,
                'sum(rate(delivery_timeout_total{job="chatapp-api"}[2m]))',
            )
            reliable_r = prom_scalar(
                prom,
                'sum(rate(ws_reliable_delivery_total{job="chatapp-api"}[2m]))',
            )
            z95 = prom_scalar(
                prom,
                'histogram_quantile(0.95, sum by (le) (rate(ws_pending_user_zset_size_bucket{job="chatapp-api"}[2m])))',
            )
            z99 = prom_scalar(
                prom,
                'histogram_quantile(0.99, sum by (le) (rate(ws_pending_user_zset_size_bucket{job="chatapp-api"}[2m])))',
            )
            trim_c = prom_scalar(prom, 'sum(ws_pending_replay_user_trimmed_total{job="chatapp-api"})')
            guard_c = prom_scalar(prom, 'sum(ws_pending_replay_guard_total{job="chatapp-api"})')
            trim_d = guard_d = None
            if trim_c is not None and prev_trim is not None:
                trim_d = trim_c - prev_trim
            if guard_c is not None and prev_guard is not None:
                guard_d = guard_c - prev_guard
            prev_trim = trim_c if trim_c is not None else prev_trim
            prev_guard = guard_c if guard_c is not None else prev_guard

            fd = fanout_done_count(ssh, lua)
            row = {
                "i": i,
                "ts": now,
                "redis_mem_pct": mem_pct,
                "redis_expired_keys_per_s": ev_r,
                "redis_evicted_keys_per_s": evict_r,
                "delivery_timeout_per_s": delivery_r,
                "ws_reliable_delivery_per_s": reliable_r,
                "ws_pending_zset_p95": z95,
                "ws_pending_zset_p99": z99,
                "ws_trim_delta_1m": trim_d,
                "ws_guard_delta_1m": guard_d,
                "ws_trim_cum": trim_c,
                "ws_guard_cum": guard_c,
                "fanout_done_capped_count": fd,
            }
            log.write(json.dumps(row) + "\n")
            log.flush()
            print(json.dumps(row), flush=True)
            if mem_pct is not None:
                mem_series.append(mem_pct)
    finally:
        log.close()
        try:
            out, _ = proc.communicate(timeout=240)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _ = proc.communicate(timeout=30)
        if out:
            with open(out_path, "a", encoding="utf-8") as loga:
                loga.write("\n--- load_stdout ---\n" + out[-12000:] + "\n")

    # --- analysis ---
    lines = []
    with open(out_path, encoding="utf-8") as rf:
        for x in rf:
            x = x.strip()
            if x.startswith("{"):
                lines.append(json.loads(x))
    mems = [float(r["redis_mem_pct"]) for r in lines if r.get("redis_mem_pct") is not None]
    evs = [float(r["redis_expired_keys_per_s"]) for r in lines if r.get("redis_expired_keys_per_s") is not None]

    growth_per_min = None
    if len(mems) >= 2:
        growth_per_min = (mems[-1] - mems[0]) / max(1, len(mems) - 1)

    decay_mean = sum(evs) / len(evs) if evs else None

    plateau = False
    span5 = None
    if len(mems) >= 5:
        tail5 = mems[-5:]
        span5 = max(tail5) - min(tail5)
        plateau = span5 <= 0.5

    print("\n=== analysis ===", flush=True)
    if not mems:
        print("no memory samples", flush=True)
        return
    print(f"n_samples={len(mems)} mem_first={mems[0]:.3f}% mem_last={mems[-1]:.3f}%", flush=True)
    gstr = f"{growth_per_min:.4f}" if growth_per_min is not None else "n/a"
    print(f"growth_approx_per_{interval}s_interval_pct_pts≈{gstr}", flush=True)
    print(f"mean_expired_keys_rate_per_s={decay_mean}", flush=True)
    evs2 = [float(r["redis_evicted_keys_per_s"]) for r in lines if r.get("redis_evicted_keys_per_s") is not None]
    if evs2:
        print(f"max_evicted_keys_rate_per_s={max(evs2)}", flush=True)
    fds = [r.get("fanout_done_capped_count") for r in lines if r.get("fanout_done_capped_count")]
    if len(fds) >= 2:
        print(f"fanout_done_first={fds[0]!r} fanout_done_last={fds[-1]!r}", flush=True)
    sp = f"{span5:.3f}" if span5 is not None else "n/a"
    print(f"plateau_last5_span<=0.5pct: {'YES' if plateau else 'NO'} (span5={sp})", flush=True)


if __name__ == "__main__":
    main()
