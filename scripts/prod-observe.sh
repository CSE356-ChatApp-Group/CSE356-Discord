#!/usr/bin/env bash
# One-shot production health + log snapshot (run from your laptop with SSH access).
# Usage:
#   ./scripts/prod-observe.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 SINCE='4 hours ago' ./scripts/prod-observe.sh
#   PROD_PUBLIC_HOST=group-8.cse356.compas.cs.stonybrook.edu ./scripts/prod-observe.sh
#   POST_MSG_MINUTES=15 ./scripts/prod-observe.sh   # rolling window for POST /messages breakdown
# Repeat checks every 2m (only POST /messages block + header):  watch -n 120 'POST_MSG_MINUTES=30 ./scripts/prod-observe.sh 2>&1 | head -n 12'
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
PROD_PUBLIC_HOST="${PROD_PUBLIC_HOST:-group-8.cse356.compas.cs.stonybrook.edu}"
SINCE="${SINCE:-2 hours ago}"
POST_MSG_MINUTES="${POST_MSG_MINUTES:-30}"
SINCE_Q=$(printf '%q' "$SINCE")
PUBLIC_HOST_Q=$(printf '%q' "$PROD_PUBLIC_HOST")

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" bash <<EOF
set -euo pipefail
SINCE=${SINCE_Q}
PUBLIC_HOST=${PUBLIC_HOST_Q}
export POST_MSG_MINUTES=${POST_MSG_MINUTES}
echo "=== \$(date -u) (UTC) | \$(hostname) ==="
echo "=== nginx: POST /api/v1/messages by status (rolling \${POST_MSG_MINUTES} min UTC, tail up to 400k lines) ==="
python3 <<'PY'
import datetime, os, re, subprocess
from collections import Counter

def tail_access(n=400_000):
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
pat = re.compile(r"\[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2})")
status_re = re.compile(r'HTTP/[\d.]+"\s+(\d{3})\s+')
minutes = max(1, min(1440, int(os.environ.get("POST_MSG_MINUTES", "30"))))
cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)

def parse_ts(line):
    m = pat.search(line)
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

posts = []
for line in tail_access():
    ts = parse_ts(line)
    if ts is None or ts < cutoff:
        continue
    if "POST /api/v1/messages" not in line:
        continue
    sm = status_re.search(line)
    posts.append(sm.group(1) if sm else "?")

total = len(posts)
print(f"window_minutes={minutes}  total_post_messages={total}")
if total == 0:
    print("(no POST /messages lines in window — log empty or tail too small)")
else:
    for k, v in sorted(Counter(posts).items(), key=lambda kv: -kv[1]):
        pct = 100.0 * v / total
        print(f"  {k}: {v} ({pct:.1f}%)")
PY
echo "=== journal window: --since \$SINCE ==="
echo "=== systemd chatapp@* ==="
systemctl is-active chatapp@4000 chatapp@4001 2>/dev/null || sudo systemctl is-active chatapp@4000 chatapp@4001
echo "=== GET /health (localhost:4000) ==="
curl -fsS -m 5 -H "Host: \${PUBLIC_HOST}" http://127.0.0.1:4000/health | head -c 500 || echo "curl failed"
echo
echo "=== GET /health (via nginx :80, edge path; follow redirects) ==="
curl -fsSL -m 5 -H "Host: \${PUBLIC_HOST}" http://127.0.0.1/health | head -c 500 || echo "curl edge failed"
echo
echo "=== nginx access: recent 502/503 (last ~2000 lines) ==="
sudo tail -n 2000 /var/log/nginx/access.log 2>/dev/null | grep -E ' (502|503) ' | tail -n 15 || true
echo "=== journal: warnings from app (pino-http 4xx/slow, logger.warn+) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p warning --no-pager -n 30 || true
echo "=== journal: errors (5xx / unhandled / systemd) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p err --no-pager -n 20 || true
echo "=== nginx: last [error] lines ==="
sudo grep '[[]error[]]' /var/log/nginx/error.log 2>/dev/null | tail -n 8 || true
EOF
