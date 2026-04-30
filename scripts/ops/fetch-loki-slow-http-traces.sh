#!/usr/bin/env bash
# Pull slow_http_request_trace lines from Loki for a recent window (default 15m).
#
# Requires LOKI_URL reachable from this host, e.g. after:
#   ssh -L 3100:127.0.0.1:3100 ubuntu@<monitoring-public-ip> -N
#
# Usage:
#   LOKI_URL=http://127.0.0.1:3100 WINDOW_MIN=15 ./scripts/ops/fetch-loki-slow-http-traces.sh > traces.ndjson
#   node scripts/ops/aggregate-slow-http-traces.cjs traces.ndjson
#
set -euo pipefail
LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
WINDOW_MIN="${WINDOW_MIN:-15}"
LIMIT="${LIMIT:-5000}"

end_ns=$(date +%s)000000000
start_ns=$(( $(date +%s) - WINDOW_MIN * 60 ))000000000

# Log line contains the pino JSON; match stable substring.
query='{job="chatapp"} |= "slow_http_request_trace"'

enc_q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$query")

url="${LOKI_URL%/}/loki/api/v1/query_range?query=${enc_q}&limit=${LIMIT}&start=${start_ns}&end=${end_ns}"

curl -fsS "$url" | python3 - <<'PY'
import json, sys
d = json.load(sys.stdin)
res = d.get("data", {}).get("result", [])
for stream in res:
    for ts, line in stream.get("values", []):
        sys.stdout.write(line)
        if not line.endswith("\n"):
            sys.stdout.write("\n")
PY
