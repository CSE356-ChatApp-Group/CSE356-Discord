#!/usr/bin/env bash
# Synthetic HTTP probe: independent of load harness. Use from cron on a small VM,
# laptop, or CI — not from the same process that drives k6/COMPAS traffic.
#
# Usage:
#   ./scripts/ops/synthetic-probe.sh 'https://example.com/health'
#   BASE_URL=https://example.com/health ./scripts/ops/synthetic-probe.sh
#   SYNTHETIC_PROBE_URLS='http://127.0.0.1/health http://127.0.0.1:4000/health' ./scripts/ops/synthetic-probe.sh
#
# URL resolution (first match wins):
#   1) First positional argument (single URL)
#   2) BASE_URL (single URL)
#   3) SYNTHETIC_PROBE_URLS (space-separated; each tried in order until one succeeds)
#   4) Default list: nginx :80 first, then common Node ports (matches prod/staging layouts)
#
# Optional: write Prometheus textfile metrics for node_exporter (collector.textfile.directory):
#   TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector ./scripts/ops/synthetic-probe.sh
#
set -euo pipefail

deadline="${CURL_MAX_TIME:-10}"

urls=""
if [[ -n "${1:-}" ]]; then
  urls="$1"
elif [[ -n "${BASE_URL:-}" ]]; then
  urls="${BASE_URL}"
elif [[ -n "${SYNTHETIC_PROBE_URLS:-}" ]]; then
  urls="${SYNTHETIC_PROBE_URLS}"
else
  urls="http://127.0.0.1/health http://127.0.0.1:4000/health http://127.0.0.1:4001/health http://127.0.0.1:3000/health"
fi

val=0
for url in $urls; do
  if curl -fsSL -o /dev/null --max-time "$deadline" "$url"; then
    val=1
    break
  fi
done

ts_sec="$(date +%s)"

if [[ -n "${TEXTFILE_DIR:-}" ]]; then
  tmp="${TEXTFILE_DIR%/}/chatapp_synthetic_probe.prom.tmp.$$"
  {
    echo '# HELP chatapp_synthetic_probe_success 1 if last probe HTTP succeeded, else 0.'
    echo '# TYPE chatapp_synthetic_probe_success gauge'
    echo "chatapp_synthetic_probe_success ${val}"
    echo '# HELP chatapp_synthetic_probe_last_run_timestamp_seconds Unix time when probe finished.'
    echo '# TYPE chatapp_synthetic_probe_last_run_timestamp_seconds gauge'
    echo "chatapp_synthetic_probe_last_run_timestamp_seconds ${ts_sec}"
  } >"$tmp"
  mv "$tmp" "${TEXTFILE_DIR%/}/chatapp_synthetic_probe.prom"
fi

exit $((1 - val))
