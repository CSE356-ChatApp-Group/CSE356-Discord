#!/usr/bin/env bash
# Correlate nginx access + error logs with a dashboard time window.
# Access logs use $time_local like 08/Apr/2026:19:30:00 +0000 (grep 08/Apr/2026:19:).
# Error logs use 2026/04/08 19:30:00.
#
# Usage:
#   ./scripts/prod-log-correlate.sh '08/Apr/2026' '2026/04/08' 19 22
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"

ACCESS_DATE="${1:?arg1: access log date token e.g. 08/Apr/2026}"
ERROR_DATE="${2:?arg2: error.log date prefix e.g. 2026/04/08}"
H_START="${3:?arg3: start hour 0-23}"
H_END="${4:?arg4: end hour 0-23 (inclusive)}"

ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_USER}@${PROD_HOST}" \
  ACCESS_DATE="${ACCESS_DATE}" \
  ERROR_DATE="${ERROR_DATE}" \
  H_START="${H_START}" \
  H_END="${H_END}" \
  bash -s <<'REMOTE'
set -euo pipefail
echo "=== $(date -u) (UTC) | $(hostname) ==="
echo "=== Access: $ACCESS_DATE hours $H_START–$H_END | Error: $ERROR_DATE same hours ==="

aggregate_posts() {
  local pat="$1"
  local tmp
  tmp=$(mktemp)
  for f in /var/log/nginx/access.log /var/log/nginx/access.log.1; do
    if sudo test -f "$f"; then
      sudo grep -F "$pat" "$f" 2>/dev/null | grep 'POST /api/v1/messages' >>"$tmp" || true
    fi
  done
  for f in /var/log/nginx/access.log.*.gz; do
    if sudo test -f "$f"; then
      sudo zgrep -F "$pat" "$f" 2>/dev/null | grep 'POST /api/v1/messages' >>"$tmp" || true
    fi
  done
  if [[ ! -s "$tmp" ]]; then
    echo "  (no POST /messages lines matched)"
    rm -f "$tmp"
    return
  fi
  python3 -c "
import re, sys
from collections import Counter
c = Counter()
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    m = re.search(r'\" (\d{3}) ', line)
    if m:
        c[m.group(1)] += 1
for k, v in c.most_common():
    print(v, k)
" "$tmp"
  rm -f "$tmp"
}

for h in $(seq "$H_START" "$H_END"); do
  hh=$(printf '%02d' "$h")
  pat="${ACCESS_DATE}:${hh}:"
  echo "--- POST /api/v1/messages status mix | ${pat} ---"
  aggregate_posts "$pat"
done

echo "=== error.log: upstream / capacity (same wall hour on error_date) ==="
for f in /var/log/nginx/error.log /var/log/nginx/error.log.1; do
  if ! sudo test -f "$f"; then
    continue
  fi
  for h in $(seq "$H_START" "$H_END"); do
    hh=$(printf '%02d' "$h")
    pat="${ERROR_DATE} ${hh}:"
    c=$(sudo grep -F "$pat" "$f" 2>/dev/null | grep -cE 'no live upstreams|Connection refused|upstream timed out|worker_connections are not enough' || true)
    if [[ "$c" -gt 0 ]]; then
      echo "$f hour $hh: $c matching error lines"
    fi
  done
done
echo "=== done ==="
REMOTE
