#!/usr/bin/env python3
"""Write Prometheus file_sd JSON for dedicated-DB VM exporters from shared .env.

Prefers PGDUMP_DATABASE_URL (direct Postgres :5432) over DATABASE_URL (often PgBouncer :6432).
When the resolved host is missing or localhost, writes empty target lists so Prometheus
does not scrape bogus addresses (e.g. staging all-in-one).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse


def parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
            v = v[1:-1]
        out[k] = v
    return out


def host_from_db_url(url: str) -> Optional[str]:
    u = url.strip()
    for prefix in ("postgresql+asyncpg://", "postgres://", "postgresql://"):
        if u.startswith(prefix):
            u = "postgresql://" + u[len(prefix) :]
            break
    if not u.startswith("postgresql://"):
        return None
    parsed = urlparse(u)
    h = parsed.hostname
    if not h:
        return None
    return h


def main() -> int:
    env_path = Path(os.environ.get("CHATAPP_ENV_FILE", "/opt/chatapp/shared/.env"))
    out_dir = Path(os.environ.get("PROMETHEUS_FILE_SD_DIR", "/opt/chatapp-monitoring/file_sd"))
    if len(sys.argv) >= 2:
        out_dir = Path(sys.argv[1])

    empty: list[Any] = []
    out_dir.mkdir(parents=True, exist_ok=True)

    if not env_path.is_file():
        (out_dir / "db-node.json").write_text("[]\n", encoding="utf-8")
        (out_dir / "db-postgres.json").write_text("[]\n", encoding="utf-8")
        print("prometheus-db-file-sd: no .env — wrote empty file_sd targets")
        return 0

    env = parse_dotenv(env_path)
    url = (env.get("PGDUMP_DATABASE_URL") or env.get("DATABASE_URL") or "").strip()
    host = host_from_db_url(url) if url else None
    if not host or host in ("localhost", "127.0.0.1", "::1"):
        groups_node = empty
        groups_pg = empty
    else:
        groups_node = [
            {
                "targets": [f"{host}:9100"],
                "labels": {"instance": "db-vm", "role": "database-host"},
            }
        ]
        groups_pg = [
            {
                "targets": [f"{host}:9187"],
                "labels": {"instance": "db-vm", "role": "postgresql"},
            }
        ]

    (out_dir / "db-node.json").write_text(
        json.dumps(groups_node, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "db-postgres.json").write_text(
        json.dumps(groups_pg, indent=2) + "\n", encoding="utf-8"
    )
    print(f"prometheus-db-file-sd: wrote {out_dir} (host={host!r})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
