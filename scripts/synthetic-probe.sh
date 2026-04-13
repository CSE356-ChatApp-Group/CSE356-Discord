#!/usr/bin/env bash
# Synthetic HTTP probe: independent of load harness. Use from cron on a small VM,
# laptop, or CI — not from the same process that drives k6/COMPAS traffic.
#
# Usage:
#   ./scripts/synthetic-probe.sh 'https://example.com/health'
#   BASE_URL=https://example.com/health ./scripts/synthetic-probe.sh
#
# Optional: write Prometheus textfile metrics for node_exporter (collector.textfile.directory):
#   TEXTFILE_DIR=/var/lib/node_exporter/textfile_collector ./scripts/synthetic-probe.sh 'http://127.0.0.1/health'
#
set -euo pipefail

url="${1:-${BASE_URL:-http://127.0.0.1:4000/health}}"
deadline="${CURL_MAX_TIME:-5}"

if curl -fsS -o /dev/null --max-time "$deadline" "$url"; then
  val=1
else
  val=0
fi

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
