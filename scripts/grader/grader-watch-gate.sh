#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"

# Fails fast when grader watcher reports critical regressions.
# Usage:
#   ./scripts/grader/grader-watch-gate.sh
#   ./scripts/grader/grader-watch-gate.sh --since "2026-04-15T16:49:00Z"
#   ./scripts/grader/grader-watch-gate.sh --window-seconds 900
#   ./scripts/grader/grader-watch-gate.sh --since "2026-04-17T14:10:40Z" --novel-only

EVENTS_FILE="${EVENTS_FILE:-artifacts/rollout-monitoring/grader-watch-events.jsonl}"
WINDOW_SECONDS="${WINDOW_SECONDS:-600}"
SINCE_TS="${SINCE_TS:-}"
MAX_403="${MAX_403:-3}"
NOVEL_ONLY="${NOVEL_ONLY:-0}"
USE_DELIVERY_CLASSIFIER="${USE_DELIVERY_CLASSIFIER:-1}"

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
    --novel-only)
      NOVEL_ONLY="1"
      shift
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

CLASSIFY_PY="${CHATAPP_REPO_ROOT}/scripts/ops/classify-delivery-timeouts.py"

set +e
PAYLOAD="$(python3 - "$EVENTS_FILE" "$SINCE_TS" "$MAX_403" "$NOVEL_ONLY" "$USE_DELIVERY_CLASSIFIER" "$CLASSIFY_PY" <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime

path, since_raw, max_403_raw, novel_only_raw, use_classifier_raw, classify_script = (
    sys.argv[1],
    sys.argv[2],
    sys.argv[3],
    sys.argv[4],
    sys.argv[5],
    sys.argv[6],
)
max_403 = int(max_403_raw)
novel_only = novel_only_raw == "1"
use_classifier = use_classifier_raw == "1"

def parse_iso(v):
    try:
        return datetime.fromisoformat(v.replace('Z', '+00:00'))
    except Exception:
        return None

def derive_signature(obj):
    signature = str(obj.get("signature", "")).strip()
    if signature:
        return signature

    text = str(obj.get("text", ""))
    lines = []
    for raw_line in text.replace("\r", "").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        lower = line.lower()
        if lower.startswith("last error"):
            continue
        if lower == "view history":
            continue
        lines.append(line)
    return "\n".join(lines).strip()

since = parse_iso(since_raw)
if since is None:
    print("ERROR: invalid --since timestamp", file=sys.stderr)
    sys.exit(2)

critical = []
warn_403 = []
latest = None
critical_before_since = set()

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
        if ts is None:
            continue
        text = str(obj.get("text", ""))
        lower = text.lower()
        if ts < since:
            if "delivery timeout" in lower or "sendmessage failed: 5" in lower:
                sig = derive_signature(obj)
                if sig:
                    critical_before_since.add(sig)
            continue
        latest = obj
        if "delivery timeout" in lower or "sendmessage failed: 5" in lower:
            sig = derive_signature(obj)
            obj["derived_signature"] = sig
            if not novel_only or sig not in critical_before_since:
                critical.append(obj)
        if "sendmessage failed: 403" in lower:
            warn_403.append(obj)

if critical:
    # Optional classifier: downgrade reconnect-gap delivery timeout noise.
    if use_classifier:
        script = classify_script
        if script and os.path.exists(script):
            try:
                out = subprocess.check_output(
                    ["python3", script, "--events-file", path, "--since", since_raw],
                    text=True,
                )
                classified = json.loads(out)
                by_key = {}
                for item in classified.get("classified_events", []):
                    key = f"Delivery timeout | sender={item.get('sender')} channel={item.get('channel_id')} missing=[{item.get('missing')}]"
                    by_key[key] = item
                filtered = []
                reconnect_only = 0
                for item in critical:
                    txt = str(item.get("text", ""))
                    matched = None
                    for line in txt.splitlines():
                        line = line.strip()
                        if line in by_key:
                            matched = by_key[line]
                            break
                    if matched and matched.get("classification") == "reconnect_gap":
                        reconnect_only += 1
                        continue
                    filtered.append(item)
                critical = filtered
                if not critical:
                    print(json.dumps({
                        "status": "pass",
                        "since": since_raw,
                        "novel_only": novel_only,
                        "delivery_reconnect_gap_false_positives": reconnect_only,
                        "classifier_used": True,
                    }))
                    sys.exit(0)
            except Exception:
                pass
    last = critical[-1]
    print(json.dumps({
        "status": "fail",
        "reason": "novel_critical_grader_error" if novel_only else "critical_grader_error",
        "count": len(critical),
        "last_ts": last.get("ts"),
        "last_signature": last.get("derived_signature"),
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
    "novel_only": novel_only,
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
