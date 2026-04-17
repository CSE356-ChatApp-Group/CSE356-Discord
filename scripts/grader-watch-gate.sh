#!/usr/bin/env bash
set -euo pipefail

# Fails fast when grader watcher reports critical regressions.
# Ignores stale dashboard lines ("Last error — 45m ago" with age > GRADER_ERROR_MAX_AGE_MINUTES)
# and dedupes repeated polls of the same incident (same conversation / same 403 body).
# Usage:
#   ./scripts/grader-watch-gate.sh
#   ./scripts/grader-watch-gate.sh --since "2026-04-15T16:49:00Z"
#   ./scripts/grader-watch-gate.sh --window-seconds 900

EVENTS_FILE="${EVENTS_FILE:-artifacts/rollout-monitoring/grader-watch-events.jsonl}"
WINDOW_SECONDS="${WINDOW_SECONDS:-600}"
SINCE_TS="${SINCE_TS:-}"
MAX_403="${MAX_403:-3}"
# Dashboard polls rewrite "Last error — Nm ago"; ignore lines where N exceeds this (stale last error).
GRADER_ERROR_MAX_AGE_MINUTES="${GRADER_ERROR_MAX_AGE_MINUTES:-15}"

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
PAYLOAD="$(python3 - "$EVENTS_FILE" "$SINCE_TS" "$MAX_403" "$GRADER_ERROR_MAX_AGE_MINUTES" <<'PY'
import json
import re
import sys
from datetime import datetime

path, since_raw, max_403_raw, max_age_raw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
max_403 = int(max_403_raw)
max_age_min = int(max_age_raw)

def parse_iso(v):
    try:
        return datetime.fromisoformat(v.replace('Z', '+00:00'))
    except Exception:
        return None

def dashboard_error_age_minutes(text):
    """Parse 'Last error — 12m ago' / em dash variants; None if not matched."""
    m = re.search(r"Last error[^\d]{0,8}(\d+)\s*m\s*ago", text, re.I)
    if not m:
        return None
    return int(m.group(1))

def is_fresh_dashboard_error(text):
    age = dashboard_error_age_minutes(text)
    if age is None:
        return True
    return age <= max_age_min

def delivery_timeout_fingerprint(text):
    m = re.search(r"conversation=([0-9a-f-]+)", text, re.I)
    if m:
        return ("conv", m.group(1).lower())
    stripped = re.sub(r"Last error[^\n]*\n+", "", text, flags=re.I).strip()
    return ("raw", stripped)

def fingerprint_403(text):
    body = re.sub(r"Last error[^\n]*\n+", "", text, flags=re.I).strip()
    return body

since = parse_iso(since_raw)
if since is None:
    print("ERROR: invalid --since timestamp", file=sys.stderr)
    sys.exit(2)

critical_by_fp = {}
warn_403_by_fp = {}
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
        if not is_fresh_dashboard_error(text):
            continue
        if "delivery timeout" in lower or "sendmessage failed: 5" in lower:
            fp = delivery_timeout_fingerprint(text)
            critical_by_fp[fp] = obj
        if "sendmessage failed: 403" in lower:
            fp = fingerprint_403(text)
            warn_403_by_fp[fp] = obj

critical = list(critical_by_fp.values())
warn_403 = list(warn_403_by_fp.values())

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
