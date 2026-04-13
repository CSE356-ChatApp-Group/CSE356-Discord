#!/usr/bin/env python3
"""
Exit 0 if /etc/pgbouncer/pgbouncer.ini points the app DB at a non-loopback host
(meaning PostgreSQL lives off the app VM — skip ALTER SYSTEM on local postgresql).

Exit 1 if the backend is loopback, the ini is missing, or no host= line matched.
Used by deploy-prod.sh and deploy-staging.sh before local Postgres tuning.
"""
import re
import sys
from pathlib import Path


def main() -> None:
    p = Path("/etc/pgbouncer/pgbouncer.ini")
    if not p.is_file():
        sys.exit(1)
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith(";") or s.startswith("["):
            continue
        m = re.match(r"\S+\s*=\s*host=(\S+)\s+port=", s)
        if not m:
            continue
        h = m.group(1).strip("'\"").lower()
        if h in ("127.0.0.1", "localhost", "::1"):
            sys.exit(1)
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
