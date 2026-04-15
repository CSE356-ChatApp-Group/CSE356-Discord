#!/usr/bin/env bash
set -euo pipefail

# Fails fast when grader watcher reports critical regressions.
# Usage:
#   ./scripts/grader-watch-gate.sh
#   ./scripts/grader-watch-gate.sh --since "2026-04-15T16:49:00Z"
#   ./scripts/grader-watch-gate.sh --window-seconds 900

EVENTS_FILE="${EVENTS_FILE:-artifacts/rollout-monitoring/grader-watch-events.jsonl}"
WINDOW_SECONDS="${WINDOW_SECONDS:-600}"
SINCE_TS="${SINCE_TS:-}"
MAX_403="${MAX_403:-3}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      SINCE_TS="${2:?--since requires ISO timestamp}"
      shift 2
      ;;
    --window-seconds)
      WINDOW_SECONDS="${2:?--window-seconds requires integer}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${EVENTS_FILE}" ]]; then
  echo "ERROR: watcher events file missing: ${EVENTS_FILE}" >&2
  exit 2
fi

if [[ -z "${SINCE_TS}" ]]; then
  SINCE_TS="$(date -u -v-"${WINDOW_SECONDS}"S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(( $(date +%s) - WINDOW_SECONDS ))" +%Y-%m-%dT%H:%M:%SZ)"
fi

set +e
PAYLOAD="$(python3 - "$EVENTS_FILE" "$SINCE_TS" "$MAX_403" <<'PY'
import json
import sys
from datetime import datetime

path, since_raw, max_403_raw = sys.argv[1], sys.argv[2], sys.argv[3]
max_403 = int(max_403_raw)

def parse_iso(v):
    try:
        return datetime.fromisoformat(v.replace('Z', '+00:00'))
    except Exception:
        return None

since = parse_iso(since_raw)
if since is None:
    print("ERROR: invalid --since timestamp", file=sys.stderr)
    sys.exit(2)

critical = []
warn_403 = []
latest = None

with open(path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        ts = parse_iso(str(obj.get("ts", "")))
        if ts is None or ts < since:
            continue
        text = str(obj.get("text", ""))
        latest = obj
        lower = text.lower()
        if "delivery timeout" in lower or "sendmessage failed: 5" in lower:
            critical.append(obj)
        if "sendmessage failed: 403" in lower:
            warn_403.append(obj)

if critical:
    last = critical[-1]
    print(json.dumps({
        "status": "fail",
        "reason": "critical_grader_error",
        "count": len(critical),
        "last_ts": last.get("ts"),
        "last_text": last.get("text", "")[:500],
    }))
    sys.exit(1)

if len(warn_403) >= max_403:
    last = warn_403[-1]
    print(json.dumps({
        "status": "fail",
        "reason": "repeated_403",
        "count": len(warn_403),
        "last_ts": last.get("ts"),
        "last_text": last.get("text", "")[:500],
    }))
    sys.exit(1)

print(json.dumps({
    "status": "pass",
    "since": since_raw,
    "recent_events": 0 if latest is None else 1,
    "last_ts": None if latest is None else latest.get("ts"),
    "last_text": None if latest is None else str(latest.get("text", ""))[:250],
}))
PY
)"
status=$?
set -e
echo "${PAYLOAD}"
exit "${status}"
