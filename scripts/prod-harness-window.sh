#!/usr/bin/env bash
# Correlate COMPAS / harness outage windows (minute-level) with prod evidence.
# Use UTC times — nginx and journal on the VM are UTC; align with the harness chart.
#
# Usage:
#   ./scripts/prod-harness-window.sh '2026-04-12 05:10:00' '2026-04-12 05:22:00'
#   PADDING_MIN=2 ./scripts/prod-harness-window.sh '2026-04-12 05:53:00' '2026-04-12 06:03:00'
#
# Output: padded journal (deploy + app warn/err), nginx error.log matches, access.log
#         status histogram for padded + strict window, sample 502/503/499 lines.
#
set -euo pipefail

PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
PADDING_MIN="${PADDING_MIN:-1}"
ACCESS_TAIL_LINES="${ACCESS_TAIL_LINES:-2000000}"

START_IN="${1:?Usage: $0 'START_UTC' 'END_UTC'}"
END_IN="${2:?END_UTC required}"

START_PADDED="$(python3 -c "
from datetime import datetime, timedelta, timezone
fmt = '%Y-%m-%d %H:%M:%S'
p = int('${PADDING_MIN}')
s = datetime.strptime('${START_IN}', fmt).replace(tzinfo=timezone.utc) - timedelta(minutes=p)
print(s.strftime(fmt))
")"
END_PADDED="$(python3 -c "
from datetime import datetime, timedelta, timezone
fmt = '%Y-%m-%d %H:%M:%S'
p = int('${PADDING_MIN}')
e = datetime.strptime('${END_IN}', fmt).replace(tzinfo=timezone.utc) + timedelta(minutes=p)
print(e.strftime(fmt))
")"

echo "=== Harness correlation: strict window ${START_IN} .. ${END_IN} UTC ==="
echo "=== Padded ±${PADDING_MIN}m for deploy/nginx: ${START_PADDED} .. ${END_PADDED} UTC ==="
echo "=== SSH ${PROD_USER}@${PROD_HOST} ==="

# Values contain spaces — must export inside the remote shell string, not as separate argv tokens.
ssh -o BatchMode=yes -o ConnectTimeout=25 "${PROD_USER}@${PROD_HOST}" \
  "export START_PADDED='${START_PADDED}'; export END_PADDED='${END_PADDED}'; export START_RAW='${START_IN}'; export END_RAW='${END_IN}'; export ACCESS_TAIL_LINES='${ACCESS_TAIL_LINES}'; bash -s" <<'REMOTE'
set -euo pipefail
echo "=== $(date -u '+%Y-%m-%d %H:%M:%S') UTC | $(hostname) ==="

echo "=== journalctl chatapp-deploy | ${START_PADDED} .. ${END_PADDED} ==="
sudo journalctl -t chatapp-deploy --since "$START_PADDED" --until "$END_PADDED" --no-pager 2>/dev/null || echo "(none)"

echo "=== journalctl chatapp@ warning+ | ${START_PADDED} .. ${END_PADDED} (tail 150 lines) ==="
sudo journalctl -u chatapp@4000 -u chatapp@4001 --since "$START_PADDED" --until "$END_PADDED" -p warning --no-pager 2>/dev/null | tail -n 150 || true

echo "=== nginx error.log (padded window): upstream reset / refused / timeout ==="
sudo env "START_PADDED=${START_PADDED}" "END_PADDED=${END_PADDED}" python3 <<'PY'
import os, re, subprocess
from datetime import datetime, timezone

def parse_err_ts(line):
    m = re.match(r"(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2})", line)
    if not m:
        return None
    y, mo, d, h, mi, s = map(int, m.groups())
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)

start = datetime.strptime(os.environ["START_PADDED"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
end = datetime.strptime(os.environ["END_PADDED"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
pat = re.compile(
    r"recv\(\) failed|Connection refused|upstream timed out|no live upstreams|worker_connections",
    re.I,
)
paths = ["/var/log/nginx/error.log", "/var/log/nginx/error.log.1"]
shown = 0
for path in paths:
    try:
        subprocess.run(["sudo", "test", "-r", path], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        continue
    p = subprocess.Popen(["sudo", "cat", path], stdout=subprocess.PIPE, text=True, errors="replace")
    assert p.stdout
    for line in p.stdout:
        ts = parse_err_ts(line)
        if ts is None or not (start <= ts <= end):
            continue
        if pat.search(line):
            print(line.rstrip()[:240])
            shown += 1
            if shown >= 40:
                break
    p.stdout.close()
    p.wait()
    if shown >= 40:
        break
if shown == 0:
    print("=== (no matching nginx error lines in padded window; try PADDING_MIN=5 or check log rotation) ===")
else:
    print(f"=== ({shown} nginx error lines shown, max 40) ===")
PY

echo "=== nginx access.log (tail \$ACCESS_TAIL_LINES): status by window ==="
sudo env "START_PADDED=${START_PADDED}" "END_PADDED=${END_PADDED}" "START_RAW=${START_RAW}" "END_RAW=${END_RAW}" "ACCESS_TAIL_LINES=${ACCESS_TAIL_LINES}" python3 <<'PY'
import os, re, subprocess
from datetime import datetime, timezone
from collections import Counter

MON = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}

def parse_access_ts(line):
    m = re.search(r"\[(\d{2})/([A-Za-z]{3})/(\d{4}):(\d{2}):(\d{2}):(\d{2})", line)
    if not m:
        return None
    d, mon, y, hh, mm, ss = m.groups()
    try:
        return datetime(int(y), MON[mon], int(d), int(hh), int(mm), int(ss), tzinfo=timezone.utc)
    except (KeyError, ValueError):
        return None

start_lo = datetime.strptime(os.environ["START_PADDED"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
end_hi = datetime.strptime(os.environ["END_PADDED"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
start_strict = datetime.strptime(os.environ["START_RAW"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
end_strict = datetime.strptime(os.environ["END_RAW"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
tail = int(os.environ.get("ACCESS_TAIL_LINES", "2000000"))

proc = subprocess.Popen(
    ["sudo", "tail", "-n", str(tail), "/var/log/nginx/access.log"],
    stdout=subprocess.PIPE,
    text=True,
    errors="replace",
)
assert proc.stdout
status_lo = Counter()
status_strict = Counter()
bad_samples = []
post_strict = 0
post_201_strict = 0
for line in proc.stdout:
    ts = parse_access_ts(line)
    if ts is None:
        continue
    sm = re.search(r'" (\d{3}) ', line)
    code = sm.group(1) if sm else "?"
    if start_lo <= ts <= end_hi:
        status_lo[code] += 1
        if code in ("502", "503", "499", "504") and len(bad_samples) < 15:
            bad_samples.append(line.strip()[:220])
    if start_strict <= ts <= end_strict:
        status_strict[code] += 1
        if "POST /api/v1/messages" in line and "HTTP/1.1" in line:
            post_strict += 1
            if code == "201":
                post_201_strict += 1
proc.stdout.close()
proc.wait()

print("--- Padded window HTTP status (top) ---")
for k, v in status_lo.most_common(12):
    print(f"  {v:6d}  {k}")
print("--- Strict harness window HTTP status (top) ---")
for k, v in status_strict.most_common(12):
    print(f"  {v:6d}  {k}")
print(f"--- Strict window POST /api/v1/messages lines: {post_strict} (201: {post_201_strict}) ---")
if bad_samples:
    print("--- Sample 502/503/499/504 (padded window) ---")
    for s in bad_samples:
        print(s)
if sum(status_lo.values()) == 0 and sum(status_strict.values()) == 0:
    print("--- (no access.log lines in these windows — current tail may not reach that UTC time; try ACCESS_TAIL_LINES=8000000 or ./scripts/prod-log-correlate.sh for hour buckets) ---")
PY

echo "=== done ==="
REMOTE
