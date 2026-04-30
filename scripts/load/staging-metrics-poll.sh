#!/usr/bin/env bash
# Poll staging app metrics every INTERVAL seconds during a load test.
# Writes NDJSON to stdout. Redirect to a file:
#   ./scripts/load/staging-metrics-poll.sh <run_id> <duration_secs> <interval_secs> >> .../metrics-live.ndjson
#
# Args: $1=run_id  $2=duration_secs (default 500)  $3=interval_secs (default 30)

set -euo pipefail

RUN_ID="${1:-unknown}"
DURATION="${2:-500}"
INTERVAL="${3:-30}"
APP="ssperrottet@136.114.103.71"
START=$(date +%s)
END=$(( START + DURATION ))

echo "# staging-metrics-poll started run_id=${RUN_ID} duration=${DURATION}s interval=${INTERVAL}s at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2

while [ "$(date +%s)" -lt "$END" ]; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ELAPSED=$(( $(date +%s) - START ))

  # One SSH call: collect everything in a single python snippet
  SNAP=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$APP" 'python3 - <<'"'"'PYEOF'"'"'
import subprocess, json, re, os

def curl(port, path):
    r = subprocess.run(["curl","-fsS","-m","3",f"http://127.0.0.1:{port}{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""

def metric(text, name):
    for line in text.splitlines():
        if line.startswith(name + "{") or line.startswith(name + " "):
            try: return float(line.split()[-1])
            except: pass
    return None

out = {}
load = open("/proc/loadavg").read().split()
out["load1"] = float(load[0])
out["load5"] = float(load[1])

for p in [4000, 4001]:
    m = curl(p, "/metrics")
    h = curl(p, "/health")
    k = str(p)
    out[f"cpu_{k}"] = metric(m, "process_cpu_seconds_total")
    out[f"el_p99_ms_{k}"] = round((metric(m, "nodejs_eventloop_lag_p99_seconds") or 0) * 1000, 1)
    out[f"heap_mb_{k}"] = round((metric(m, "nodejs_heap_size_used_bytes") or 0) / 1048576, 1)
    try:
        hj = json.loads(h)
        pool = hj.get("pool", {})
        out[f"pool_total_{k}"] = pool.get("total", 0)
        out[f"pool_waiting_{k}"] = pool.get("waiting", 0)
        out[f"pool_idle_{k}"] = pool.get("idle", 0)
        out[f"overload_stage_{k}"] = hj.get("overloadStage", 0)
    except: pass

redis = subprocess.run(["redis-cli","info","memory"], capture_output=True, text=True).stdout
for line in redis.splitlines():
    if line.startswith("used_memory:"):
        out["redis_mb"] = round(int(line.split(":")[1]) / 1048576, 2)

print(json.dumps(out))
PYEOF
' 2>/dev/null || echo '{}')

  printf '{"ts":"%s","elapsed_s":%d,%s}\n' \
    "$TS" "$ELAPSED" \
    "$(echo "$SNAP" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(','.join(f'\"{k}\":{json.dumps(v)}' for k,v in d.items()))" 2>/dev/null || echo '"error":"parse_fail"')"

  sleep "$INTERVAL"
done

echo "# staging-metrics-poll finished at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
