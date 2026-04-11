#!/usr/bin/env bash
# Scan recent nginx access.log on prod (or staging) and flag traffic/edge concerns.
# Run periodically from your machine:  watch -n 120 ./scripts/watch-traffic-concerns.sh
# Or loop:  INTERVAL_SEC=180 ./scripts/watch-traffic-concerns.sh --loop
#
# Env (same defaults as prod-observe.sh):
#   PROD_HOST PROD_USER  WINDOW_MINUTES  TAIL_LINES
set -euo pipefail
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
WINDOW_MINUTES="${WINDOW_MINUTES:-30}"
TAIL_LINES="${TAIL_LINES:-400000}"

LOOP=0
if [[ "${1:-}" == "--loop" ]]; then
  LOOP=1
  INTERVAL_SEC="${INTERVAL_SEC:-180}"
fi

run_once() {
  ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_USER}@${PROD_HOST}" \
    "WINDOW_MINUTES=${WINDOW_MINUTES} TAIL_LINES=${TAIL_LINES} python3" <<'PY'
import datetime, os, re, subprocess
from collections import Counter

def tail_access(n):
    try:
        return subprocess.check_output(
            ["sudo", "tail", "-n", str(n), "/var/log/nginx/access.log"],
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
        ).splitlines()
    except subprocess.CalledProcessError:
        return []

MON = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}
ts_pat = re.compile(r"\[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2})")
# Combined: "METHOD path HTTP/x.y" STATUS
status_pat = re.compile(r'"([A-Z]+)\s+([^"\s]+)(?:\s+HTTP/[^"]+)?"\s+(\d{3})\s')

def parse_ts(line):
    m = ts_pat.search(line)
    if not m:
        return None
    day, mon_abbr, year, hh, mm, ss = m.groups()
    try:
        return datetime.datetime(
            int(year), MON[mon_abbr], int(day),
            int(hh), int(mm), int(ss),
            tzinfo=datetime.timezone.utc,
        )
    except (KeyError, ValueError):
        return None

minutes = max(1, min(1440, int(os.environ.get("WINDOW_MINUTES", "30"))))
tail_n = max(10_000, min(2_000_000, int(os.environ.get("TAIL_LINES", "400000"))))
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)

counts_5xx = Counter()
counts_edge = Counter()  # 502, 503
post_msg_status = Counter()
patch_me_status = Counter()
login_status = Counter()
lines_in_window = 0

for line in tail_access(tail_n):
    ts = parse_ts(line)
    if ts is None or ts < cutoff:
        continue
    sm = status_pat.search(line)
    if not sm:
        continue
    method, path, code_s = sm.group(1), sm.group(2), sm.group(3)
    code = int(code_s)
    lines_in_window += 1

    if code >= 500:
        counts_5xx[code] += 1
    if code in (502, 503):
        counts_edge[code] += 1

    p0 = path.split("?", 1)[0]
    if method == "POST" and "/api/v1/messages" in p0 and p0.rstrip("/").endswith("messages"):
        post_msg_status[code_s] += 1
    if method == "PATCH" and p0.rstrip("/").endswith("/users/me"):
        patch_me_status[code_s] += 1
    if method == "POST" and "/api/v1/auth/login" in p0:
        login_status[code_s] += 1

def warn(tag, ok, detail):
    flag = "[OK]" if ok else "[WARN]"
    print(f"{flag} {tag}: {detail}")

print(f"=== Traffic concerns | window={minutes}m | host={os.uname().nodename} | UTC {datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} ===")
print(f"parsed_request_lines_in_window={lines_in_window}")

total_5xx = sum(counts_5xx.values())
edge_bad = counts_edge[502] + counts_edge[503]
warn("5xx_total", total_5xx <= 10, f"{total_5xx}  " + (dict(counts_5xx) and str(dict(sorted(counts_5xx.items()))) or "{}"))

warn("nginx_502_503", edge_bad <= 15, f"502={counts_edge[502]} 503={counts_edge[503]}")

post_total = sum(post_msg_status.values())
if post_total == 0:
    warn("POST_/messages", True, "no lines in window")
else:
    ok_2xx = sum(v for k, v in post_msg_status.items() if k.startswith("2"))
    bad_pct = 100.0 * (post_total - ok_2xx) / post_total
    warn("POST_/messages_non_2xx_pct", bad_pct <= 5.0, f"{bad_pct:.1f}%  n={post_total}  by_status={dict(post_msg_status)}")

patch_400 = patch_me_status.get("400", 0)
patch_n = sum(patch_me_status.values())
warn("PATCH_/users/me_400", patch_400 <= 20, f"400_count={patch_400}  patch_total={patch_n}  by_status={dict(patch_me_status)}")

login_401 = login_status.get("401", 0)
login_n = sum(login_status.values())
warn("POST_login_401", True, f"401={login_401}  login_total={login_n}  (401 often expected)")

if lines_in_window == 0:
    print("[WARN] No parsed lines in time window — increase TAIL_LINES or check clock/log rotation")
PY
}

if [[ "$LOOP" -eq 1 ]]; then
  echo "Loop every ${INTERVAL_SEC}s (WINDOW_MINUTES=${WINDOW_MINUTES}). Ctrl+C to stop."
  while true; do
    echo ""
    run_once || true
    sleep "${INTERVAL_SEC}"
  done
else
  run_once
fi
