#!/usr/bin/env bash
# Diagnose slow WS delivery traces from structured JSON logs.
#
# Usage:
#   ./ops/query-slow-deliveries.sh [logfile|-]  [messageId]
#
# With no log file, reads stdin. Pass '-' explicitly for stdin.
# Filters for event=ws.delivery.slow_trace, optionally by messageId.
# Outputs:
#   - Top slow stage (by count)
#   - Affected VM/worker
#   - Affected topic type/path
#   - Full trace records sorted by total_delivery_ms desc
#
# Requires: jq >= 1.6

set -euo pipefail

LOGFILE="${1:--}"
MSG_ID="${2:-}"

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

INPUT_CMD="cat"
if [[ "$LOGFILE" != "-" ]]; then
  INPUT_CMD="cat $LOGFILE"
fi

FILTER='
  select(.event == "ws.delivery.slow_trace")
'
if [[ -n "$MSG_ID" ]]; then
  FILTER="${FILTER} | select(.messageId == \"$MSG_ID\")"
fi

echo "=== Slow WS delivery traces ==="
echo ""

TRACES=$(eval "$INPUT_CMD" | jq -c "$FILTER" 2>/dev/null || true)

if [[ -z "$TRACES" ]]; then
  echo "No slow delivery traces found."
  exit 0
fi

echo "--- Top slow stage (by count) ---"
echo "$TRACES" | jq -r '
  if .socket_enqueue_delay_ms != null and .socket_enqueue_delay_ms > 500 then "socket_enqueue_wait"
  elif .send_duration_ms != null and .send_duration_ms > 500 then "socket_write"
  elif .pubsub_receive_lag_ms != null and .pubsub_receive_lag_ms > 500 then "pubsub_receive"
  elif .total_delivery_ms != null and .total_delivery_ms > 1000 then "total_end_to_end"
  elif .stale_map_recovery == true then "stale_map_recovery"
  elif .partial_delivery == true then "partial_delivery"
  else "other"
  end
' | sort | uniq -c | sort -rn | head -10

echo ""
echo "--- Affected VM/worker ---"
echo "$TRACES" | jq -r '.dest_vm + "/" + (.dest_worker // "?")' | sort | uniq -c | sort -rn | head -10

echo ""
echo "--- Affected topic type ---"
echo "$TRACES" | jq -r '.topicType // "unknown"' | sort | uniq -c | sort -rn | head -10

echo ""
echo "--- Slowest 10 traces (total_delivery_ms desc) ---"
echo "$TRACES" | jq -s '
  sort_by(-.total_delivery_ms) | .[0:10][] |
  {
    messageId,
    total_delivery_ms,
    pubsub_receive_lag_ms,
    socket_enqueue_delay_ms,
    send_duration_ms,
    stale_map_recovery,
    partial_delivery,
    dest_vm,
    dest_worker,
    topicType,
    channelId,
    recipientUserId
  }
'

echo ""
TRACE_COUNT=$(echo "$TRACES" | wc -l | tr -d ' ')
echo "Total slow trace records: $TRACE_COUNT"
