#!/usr/bin/env python3
"""
Classify grader delivery-timeout alerts using recipient connectivity evidence.

Outputs JSON with:
  - classified_events[]
  - counts.true_delivery_failures
  - counts.reconnect_gap_false_positives
  - counts.send_path_failures
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shlex
import subprocess
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


DELIVERY_RE = re.compile(
    r"Delivery timeout \| sender=(?P<sender>[^\s]+)\s+channel=(?P<channel>[0-9a-fA-F-]{36})\s+missing=\[(?P<missing>[^\]]*)\]",
    re.IGNORECASE,
)


@dataclass
class DeliveryEvent:
    ts: dt.datetime
    sender: str
    channel_id: str
    missing_usernames: list[str]
    raw_text: str


def parse_iso(ts: str) -> dt.datetime | None:
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def run_ssh(host: str, cmd: str) -> str:
    out = subprocess.check_output(
        ["ssh", host, cmd],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    return out


def read_events(path: str, since: dt.datetime) -> list[DeliveryEvent]:
    events: list[DeliveryEvent] = []
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
            if not ts or ts < since:
                continue
            text = str(obj.get("text", ""))
            for raw in text.replace("\r", "").split("\n"):
                m = DELIVERY_RE.search(raw.strip())
                if not m:
                    continue
                missing = [x.strip() for x in m.group("missing").split(",") if x.strip()]
                events.append(
                    DeliveryEvent(
                        ts=ts,
                        sender=m.group("sender").strip(),
                        channel_id=m.group("channel").strip(),
                        missing_usernames=missing,
                        raw_text=raw.strip(),
                    )
                )
    return events


def db_user_ids(db_ssh: str, usernames: set[str]) -> dict[str, str]:
    if not usernames:
        return {}
    quoted = ", ".join("'" + u.replace("'", "''") + "'" for u in sorted(usernames))
    sql = f"SELECT username,id FROM users WHERE username IN ({quoted});"
    cmd = (
        "sudo -u postgres psql -d chatapp_prod -At -F $'\\t' -c "
        + shlex.quote(sql)
    )
    out = run_ssh(db_ssh, cmd)
    mapping: dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 2:
            mapping[parts[0].strip()] = parts[1].strip()
    return mapping


def db_sender_message_exists(
    db_ssh: str, sender_id: str, channel_id: str, ts: dt.datetime, window_s: int = 30
) -> bool:
    start = (ts - dt.timedelta(seconds=window_s)).isoformat()
    end = (ts + dt.timedelta(seconds=window_s)).isoformat()
    sql = f"""
SELECT EXISTS (
  SELECT 1
  FROM messages
  WHERE channel_id = '{channel_id}'::uuid
    AND author_id = '{sender_id}'::uuid
    AND deleted_at IS NULL
    AND created_at BETWEEN '{start}'::timestamptz AND '{end}'::timestamptz
);
"""
    cmd = (
        "sudo -u postgres psql -d chatapp_prod -At -F $'\\t' -c "
        + shlex.quote(sql)
    )
    out = run_ssh(db_ssh, cmd).strip().lower()
    return out in ("t", "true", "1")


def loki_ws_events(
    monitoring_ssh: str, user_id: str, ts: dt.datetime
) -> list[dict[str, Any]]:
    start_ns = int((ts - dt.timedelta(seconds=180)).timestamp() * 1e9)
    end_ns = int((ts + dt.timedelta(seconds=240)).timestamp() * 1e9)
    query = f'{{job="chatapp"}} |= "{user_id}" |= "ws."'
    py = f"""
import json, urllib.parse, urllib.request
u='http://127.0.0.1:3100/loki/api/v1/query_range?'+urllib.parse.urlencode({{
  'query': {query!r},
  'start': {str(start_ns)!r},
  'end': {str(end_ns)!r},
  'limit': '2000',
  'direction': 'forward'
}})
d=json.load(urllib.request.urlopen(u,timeout=30))
rows=[]
for st in d.get('data',{{}}).get('result',[]):
  host=st.get('stream',{{}}).get('host')
  unit=st.get('stream',{{}}).get('unit')
  for ts,line in st.get('values',[]):
    try:
      obj=json.loads(line)
    except Exception:
      continue
    rows.append({{'ts':int(ts),'host':host,'unit':unit,'event':obj.get('event'),'bootstrapReady':obj.get('bootstrapReady'),'replayedMessages':obj.get('replayedMessages')}})
print(json.dumps(rows))
"""
    out = run_ssh(monitoring_ssh, "python3 - <<'PY'\n" + py + "\nPY")
    try:
        return json.loads(out)
    except Exception:
        return []


def loki_send_path_503_seen(
    monitoring_ssh: str, channel_id: str, ts: dt.datetime
) -> bool:
    start_ns = int((ts - dt.timedelta(seconds=20)).timestamp() * 1e9)
    end_ns = int((ts + dt.timedelta(seconds=20)).timestamp() * 1e9)
    query = f'{{job="chatapp"}} |= "{channel_id}" |= "channel insert lock timed out"'
    py = f"""
import json, urllib.parse, urllib.request
u='http://127.0.0.1:3100/loki/api/v1/query_range?'+urllib.parse.urlencode({{
  'query': {query!r},
  'start': {str(start_ns)!r},
  'end': {str(end_ns)!r},
  'limit': '200',
  'direction': 'forward'
}})
d=json.load(urllib.request.urlopen(u,timeout=30))
print(sum(len(st.get('values',[])) for st in d.get('data',{{}}).get('result',[])))
"""
    try:
        out = run_ssh(monitoring_ssh, "python3 - <<'PY'\n" + py + "\nPY").strip()
        return int(out or "0") > 0
    except Exception:
        return False


def classify_one(
    db_ssh: str,
    monitoring_ssh: str,
    sender_username: str,
    sender_id: str | None,
    channel_id: str,
    missing_username: str,
    missing_id: str | None,
    ts: dt.datetime,
) -> dict[str, Any]:
    send_path_503_seen = loki_send_path_503_seen(monitoring_ssh, channel_id, ts)
    send_path_successful = (
        bool(sender_id) and db_sender_message_exists(db_ssh, sender_id, channel_id, ts)
    )
    ws_rows = loki_ws_events(monitoring_ssh, missing_id, ts) if missing_id else []
    ts_ns = int(ts.timestamp() * 1e9)

    disconnect_before = None
    reconnect_after = None
    replay_after = None
    bootstrap_complete = None
    for row in ws_rows:
        rts = int(row.get("ts", 0))
        event = str(row.get("event") or "")
        if event == "ws.disconnected" and (ts_ns - 180_000_000_000) <= rts <= (ts_ns + 30_000_000_000):
            disconnect_before = row
            if isinstance(row.get("bootstrapReady"), bool):
                bootstrap_complete = bool(row.get("bootstrapReady"))
        if event == "ws.reconnected_after_gap" and (ts_ns - 30_000_000_000) <= rts <= (ts_ns + 240_000_000_000):
            reconnect_after = row
        if event == "ws.replay.missed_messages" and (ts_ns - 30_000_000_000) <= rts <= (ts_ns + 240_000_000_000):
            replay_after = row

    recipient_disconnected_gap = bool(disconnect_before and reconnect_after)
    replay_after_gap_seen = bool(replay_after)
    recipient_connected_at_send = not recipient_disconnected_gap
    # We do not currently have a dedicated fanout publish log per recipient.
    # Use successful send-path as the nearest proxy.
    fanout_publish_seen = bool(send_path_successful)

    if recipient_disconnected_gap and replay_after_gap_seen:
        classification = "reconnect_gap"
    elif send_path_503_seen:
        classification = "send_path_failure"
    elif (
        recipient_connected_at_send
        and fanout_publish_seen
        and recipient_bootstrap_complete_is_ready(bootstrap_complete)
        and not replay_after_gap_seen
    ):
        classification = "true_delivery_failure"
    else:
        classification = "true_delivery_failure"

    return {
        "ts": ts.isoformat(),
        "sender": sender_username,
        "channel_id": channel_id,
        "missing": missing_username,
        "classification": classification,
        "recipient_connected_at_send": recipient_connected_at_send,
        "recipient_bootstrap_complete": bootstrap_complete,
        "recipient_disconnected_gap": recipient_disconnected_gap,
        "replay_after_gap_seen": replay_after_gap_seen,
        "fanout_publish_seen": fanout_publish_seen,
        "send_path_successful": send_path_successful,
        "send_path_503_seen": send_path_503_seen,
    }


def recipient_bootstrap_complete_is_ready(v: bool | None) -> bool:
    # Unknown should not block failure classification; only explicit false blocks.
    return v is not False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--events-file", default="artifacts/rollout-monitoring/grader-watch-events.jsonl")
    ap.add_argument("--since", default="")
    ap.add_argument("--window-seconds", type=int, default=1800)
    ap.add_argument("--prod-db-ssh", default="ubuntu@130.245.136.21")
    ap.add_argument("--monitoring-ssh", default="ubuntu@130.245.136.120")
    args = ap.parse_args()

    if args.since:
        since = parse_iso(args.since)
        if since is None:
            print(json.dumps({"error": "invalid --since"}))
            return 2
    else:
        since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=max(1, args.window_seconds))

    events = read_events(args.events_file, since)
    usernames: set[str] = set()
    for e in events:
        usernames.add(e.sender)
        usernames.update(e.missing_usernames)
    user_ids = db_user_ids(args.prod_db_ssh, usernames) if usernames else {}

    classified: list[dict[str, Any]] = []
    for e in events:
        sender_id = user_ids.get(e.sender)
        for missing in e.missing_usernames:
            classified.append(
                classify_one(
                    db_ssh=args.prod_db_ssh,
                    monitoring_ssh=args.monitoring_ssh,
                    sender_username=e.sender,
                    sender_id=sender_id,
                    channel_id=e.channel_id,
                    missing_username=missing,
                    missing_id=user_ids.get(missing),
                    ts=e.ts,
                )
            )

    counts = {
        "true_delivery_failures": sum(1 for x in classified if x["classification"] == "true_delivery_failure"),
        "reconnect_gap_false_positives": sum(1 for x in classified if x["classification"] == "reconnect_gap"),
        "send_path_failures": sum(1 for x in classified if x["classification"] == "send_path_failure"),
    }
    print(json.dumps({"since": since.isoformat(), "classified_events": classified, "counts": counts}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
