#!/usr/bin/env python3
"""
If DATABASE_URL uses PgBouncer (:6432) and PGDUMP_DATABASE_URL is missing, append
PGDUMP_DATABASE_URL to /opt/chatapp/shared/.env pointing at the real Postgres host:port
from /etc/pgbouncer/pgbouncer.ini (same user/password/db as DATABASE_URL).

Run on the app VM: sudo python3 deploy/ensure-pgdump-env.py
"""
from __future__ import annotations

import os
import re
import sys
import urllib.parse
from pathlib import Path

ENV_PATH = Path("/opt/chatapp/shared/.env")
INI_PATH = Path("/etc/pgbouncer/pgbouncer.ini")


def main() -> None:
    if os.geteuid() != 0:
        print("ERROR: run as root: sudo python3 ensure-pgdump-env.py", file=sys.stderr)
        sys.exit(1)
    text = ENV_PATH.read_text(encoding="utf-8", errors="replace")
    if re.search(r"^PGDUMP_DATABASE_URL=", text, re.MULTILINE):
        print("PGDUMP_DATABASE_URL already set — OK")
        return
    m = re.search(r"^DATABASE_URL=(.+)$", text, re.MULTILINE)
    if not m:
        print("ERROR: DATABASE_URL not found in", ENV_PATH, file=sys.stderr)
        sys.exit(1)
    raw = m.group(1).strip().strip('"').strip("'")
    r = urllib.parse.urlparse(raw)
    if (r.port or 5432) != 6432:
        print("DATABASE_URL is not PgBouncer (:6432) — PGDUMP not required; OK")
        return
    ini = INI_PATH.read_text(encoding="utf-8", errors="replace")
    mh = re.search(r"^\s*\S+\s*=\s*host=(\S+)\s+port=(\d+)", ini, re.MULTILINE)
    if not mh:
        print("ERROR: could not parse backend host from", INI_PATH, file=sys.stderr)
        sys.exit(1)
    host = mh.group(1).strip("'\"").lower()
    port = int(mh.group(2))
    user = urllib.parse.unquote(r.username or "chatapp")
    password = urllib.parse.unquote(r.password or "")
    path = r.path or "/"
    scheme = r.scheme or "postgres"
    if scheme == "postgresql":
        scheme = "postgres"
    netloc = (
        f"{urllib.parse.quote(user, safe='')}:"
        f"{urllib.parse.quote(password, safe='')}"
        f"@{host}:{port}"
    )
    new_url = urllib.parse.urlunparse((scheme, netloc, path, "", "", ""))
    line = f"PGDUMP_DATABASE_URL={new_url}\n"
    with ENV_PATH.open("a", encoding="utf-8") as f:
        f.write(line)
    print(f"Appended PGDUMP_DATABASE_URL → {host}:{port}")


if __name__ == "__main__":
    main()
