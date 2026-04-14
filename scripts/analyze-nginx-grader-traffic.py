#!/usr/bin/env python3
"""
Infer automation/grader-like HTTP behavior from nginx access logs (stdin or files).

Use with production or staging logs to see what clients actually do (REST mix,
POST→GET /messages proximity, WebSocket opens), then tune caches and timeouts.

Examples:
  ssh ubuntu@HOST 'sudo tail -n 400000 /var/log/nginx/access.log' | \\
    python3 scripts/analyze-nginx-grader-traffic.py --hint-grader

  python3 scripts/analyze-nginx-grader-traffic.py /tmp/access.slice.log

Course-aligned *contract* (what we think the rubric exercises) is codified in:
  backend/scripts/api-contract-harness.cjs
List check names:  rg "^add\\('" backend/scripts/api-contract-harness.cjs
Run against staging:  npm run api-contract (see backend/package.json for env vars).
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from typing import Iterator, Optional

# Nginx combined-style: $remote_addr ... "$request" $status ...
LINE_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] "(?P<method>\S+) (?P<path>[^"\s]*)(?: [^"]*)?" (?P<status>\d{3}) '
)


def parse_ts(ts: str) -> Optional[float]:
    try:
        dt = datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S %z")
        return dt.timestamp()
    except ValueError:
        return None


def normalize_api_path(path: str) -> str:
    if not path.startswith("/api/v1/"):
        return path.split("?")[0] or path
    rest = path[len("/api/v1/") :].split("?", 1)[0]
    parts = rest.split("/")
    if not parts or parts[0] == "":
        return "/api/v1/"
    # Collapse UUID path segments so counts aggregate per route shape
    out = []
    for p in parts:
        if re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            p,
            re.I,
        ):
            out.append("{id}")
        else:
            out.append(p)
    return "/api/v1/" + "/".join(out)


def iter_lines(paths: list[str]) -> Iterator[str]:
    if not paths:
        yield from sys.stdin
        return
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as f:
            yield from f


def main() -> None:
    ap = argparse.ArgumentParser(description="Summarize API traffic from nginx access logs.")
    ap.add_argument(
        "files",
        nargs="*",
        help="Log files (default: read stdin)",
    )
    ap.add_argument(
        "--hint-grader",
        action="store_true",
        help="Keep lines where client IP is RFC1918 10.x or User-Agent looks like node/playwright",
    )
    ap.add_argument(
        "--window-sec",
        type=float,
        default=3.0,
        help="Max seconds after POST /messages to count a GET /messages as a follow-up (default 3)",
    )
    args = ap.parse_args()

    window = max(0.5, float(args.window_sec))

    total_lines = 0
    matched = 0
    status_post_messages = Counter()
    normalized_hits = Counter()
    ws_gets = 0
    post_messages = 0
    get_messages = 0
    get_messages_after_recent_post = 0

    # Recent POST /messages timestamps per client IP (for sniffing GET-after-POST patterns)
    recent_posts: dict[str, list[float]] = defaultdict(list)
    PRUNE_SEC = 120.0

    def prune_posts(ip: str, t: float) -> None:
        arr = recent_posts[ip]
        recent_posts[ip] = [p for p in arr if t - p <= PRUNE_SEC]

    def track_post(ip: str, t: float) -> None:
        nonlocal post_messages
        post_messages += 1
        prune_posts(ip, t)
        recent_posts[ip].append(t)

    def track_get_messages(ip: str, t: float) -> None:
        nonlocal get_messages, get_messages_after_recent_post
        get_messages += 1
        prune_posts(ip, t)
        matched = False
        for p in recent_posts[ip]:
            if p <= t and 0 <= t - p <= window:
                matched = True
                break
        if matched:
            get_messages_after_recent_post += 1

    def hint_grader_line(line: str, ip: str) -> bool:
        if ip.startswith("10."):
            return True
        if "node" in line.lower() and '"node"' in line:
            return True
        if "playwright" in line.lower():
            return True
        return False

    for line in iter_lines(args.files):
        total_lines += 1
        line = line.rstrip("\n")
        if args.hint_grader:
            m0 = LINE_RE.match(line)
            if not m0:
                continue
            if not hint_grader_line(line, m0.group("ip")):
                continue
        m = LINE_RE.match(line)
        if not m:
            continue
        matched += 1
        ip = m.group("ip")
        method = m.group("method").upper()
        path = m.group("path")
        status = m.group("status")
        t = parse_ts(m.group("ts"))
        if t is None:
            continue

        if method == "GET" and path.startswith("/ws"):
            ws_gets += 1

        if path.startswith("/api/v1/"):
            norm = normalize_api_path(path)
            normalized_hits[f"{method} {norm}"] += 1

        if method == "POST" and path.startswith("/api/v1/messages"):
            status_post_messages[status] += 1
            track_post(ip, t)
        elif method == "GET" and path.startswith("/api/v1/messages"):
            track_get_messages(ip, t)

    print(f"lines_total={total_lines} lines_parsed={matched} hint_grader={args.hint_grader}")
    print(f"ws_gets={ws_gets}")
    print(f"POST_/api/v1/messages_total={post_messages}")
    if status_post_messages:
        print("POST_/api/v1/messages_by_status:")
        for k, v in status_post_messages.most_common():
            print(f"  {k}: {v}")

    if get_messages:
        print(
            f"GET_/api/v1/messages_with_POST_predecessor_same_ip_within_{window:g}s="
            f"{get_messages_after_recent_post}/{get_messages} "
            f"({100.0 * get_messages_after_recent_post / get_messages:.1f}%)"
        )
    print(f"GET_POST_ratio_messages_endpoint={get_messages}/{max(1, post_messages)}")

    print("\nTop 40 normalized /api/v1 routes (method + path shape):")
    for key, v in normalized_hits.most_common(40):
        print(f"  {v:6d}  {key}")

    print(
        "\nProxy for official checks: backend/scripts/api-contract-harness.cjs "
        "(npm run api-contract). List: rg \"^add\\\\('\" backend/scripts/api-contract-harness.cjs"
    )


if __name__ == "__main__":
    main()
