#!/usr/bin/env python3
"""Validate chatapp-nginx-ratelimit failregex against nginx-shaped lines.

Reads failregex from filter.d/chatapp-nginx-ratelimit.conf (single source of truth).
Run locally or in CI: python3 deploy/fail2ban/verify_filter.py

On the nginx host, still use: fail2ban-regex /path/to/access.log /etc/fail2ban/filter.d/...
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILTER = ROOT / "deploy/fail2ban/filter.d/chatapp-nginx-ratelimit.conf"


def load_failregex(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("failregex") and "=" in line:
            return line.split("=", 1)[1].strip()
    print(f"error: no failregex= line in {path}", file=sys.stderr)
    sys.exit(1)
    raise AssertionError  # unreachable


def compile_pattern(failregex: str) -> re.Pattern[str]:
    # <HOST> matches the client IP; fixtures use IPv4 — permissive token is enough here.
    substituted = failregex.replace("<HOST>", r"(?P<host>\S+)")
    return re.compile(substituted)


def main() -> None:
    if not FILTER.is_file():
        print(f"error: missing {FILTER}", file=sys.stderr)
        sys.exit(1)

    pat = compile_pattern(load_failregex(FILTER))

    must_match = [
        (
            "503, no space between ] and request quote (nginx default combined shape)",
            '9.9.9.9 - - [23/Apr/2026:12:00:00 +0000]"GET / HTTP/1.1" 503 1693 "-" "curl/8.5.0" rt=0.000 urt=-',
        ),
        (
            "503, space between ] and quote (tolerant)",
            '9.9.9.9 - - [23/Apr/2026:12:00:00 +0000] "POST /api/x HTTP/1.1" 503 12 "-" "curl/8.5.0" rt=0.000 urt=-',
        ),
    ]

    must_not_match = [
        (
            "200 with urt=- must not match (urt=- is not abuse-specific)",
            '138.197.113.17 - - [23/Apr/2026:18:43:08 +0000]"GET / HTTP/1.1" 200 1693 "-" "curl/8.5.0" rt=0.000 urt=-',
        ),
        (
            "503 but upstream time present",
            '9.9.9.9 - - [23/Apr/2026:12:00:00 +0000]"GET / HTTP/1.1" 503 1693 "-" "curl/8.5.0" rt=0.000 urt=0.001',
        ),
    ]

    failed = False
    for label, line in must_match:
        if not pat.match(line):
            print(f"FAIL expected match: {label}\n  {line!r}", file=sys.stderr)
            failed = True

    for label, line in must_not_match:
        if pat.match(line):
            print(f"FAIL expected no match: {label}\n  {line!r}", file=sys.stderr)
            failed = True

    if failed:
        sys.exit(1)

    print(f"ok: failregex from {FILTER.relative_to(ROOT)} matches {len(must_match)} / rejects {len(must_not_match)} checks")


if __name__ == "__main__":
    main()
