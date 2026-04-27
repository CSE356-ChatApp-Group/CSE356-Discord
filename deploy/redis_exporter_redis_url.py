#!/usr/bin/env python3
"""Emit Redis URL for redis_exporter from /opt/chatapp/shared/.env (stdout, one line).

redis_exporter reads REDIS_ADDR; credentials must be URL-encoded (e.g. @ : / in ACL
passwords) or the exporter fails auth and redis_up stays 0.

Also: ``python3 redis_exporter_redis_url.py slowlog [N]`` — run ``redis-cli`` with the
same credentials (argv + REDISCLI_AUTH), avoiding ``redis-cli -u`` URL quirks, and print
a short SLOWLOG summary when ``--json`` is available.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse, urlunparse

DEFAULT = "redis://127.0.0.1:6379"
ENV_PATH = Path(os.environ.get("ENV_PATH", "/opt/chatapp/shared/.env"))


def _strip_quotes(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


def _load_raw_redis_url_from_env() -> str:
    env_url = os.environ.get("REDIS_URL", "").strip()
    if env_url:
        return _strip_quotes(env_url)
    if not ENV_PATH.is_file():
        return DEFAULT
    for raw in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        if s.lower().startswith("export "):
            s = s[7:].strip()
        if s.startswith("REDIS_URL="):
            v = s.split("=", 1)[1].strip()
            return _strip_quotes(v) if v else DEFAULT
    return DEFAULT


def _parse_redis_url(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    if not raw:
        return {"ok": False, "raw": DEFAULT}
    parsed = urlparse(raw)
    if not parsed.hostname:
        return {"ok": False, "raw": raw}
    scheme = parsed.scheme or "redis"
    host = parsed.hostname
    port = int(parsed.port or 6379)
    username = _strip_quotes(unquote(parsed.username or ""))
    password = unquote(parsed.password or "") if parsed.password else ""
    if password:
        password = _strip_quotes(password)
    return {
        "ok": True,
        "scheme": scheme,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "path": parsed.path or "",
        "query": parsed.query,
        "fragment": parsed.fragment,
    }


def _sanitize_redis_url(raw: str) -> str:
    p = _parse_redis_url(raw)
    if not p["ok"]:
        return p["raw"]
    scheme = p["scheme"]
    host = p["host"]
    port = p["port"]
    username = p["username"]
    password = p["password"]

    if username or password:
        u = quote(username, safe="")
        p_enc = quote(password, safe="")
        if u and p_enc:
            auth = f"{u}:{p_enc}"
        elif p_enc:
            auth = f":{p_enc}"
        else:
            auth = u
        netloc = f"{auth}@{host}:{port}"
    else:
        netloc = f"{host}:{port}"

    return urlunparse(
        (
            scheme,
            netloc,
            p["path"],
            "",
            p["query"],
            p["fragment"],
        ),
    )


def _redis_cli_env_and_argv(
    *redis_args: str,
    use_json: bool = False,
) -> tuple[dict[str, str], list[str]]:
    raw = _load_raw_redis_url_from_env()
    p = _parse_redis_url(raw)
    if not p["ok"]:
        host, port = "127.0.0.1", 6379
        scheme = "redis"
        username, password = "", ""
    else:
        host, port = p["host"], p["port"]
        scheme = p["scheme"]
        username, password = p["username"], p["password"]

    env = os.environ.copy()
    if password:
        env["REDISCLI_AUTH"] = password
    cmd: list[str] = ["redis-cli"]
    if scheme == "rediss":
        cmd.append("--tls")
    cmd.extend(["-h", host, "-p", str(port)])
    if username:
        cmd.extend(["--user", username])
    if use_json:
        cmd.append("--json")
    cmd.extend(redis_args)
    return env, cmd


def _slowlog_emit_summary(entries: Any) -> None:
    if not isinstance(entries, list):
        return
    stats: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # count, max_micros
    for e in entries:
        if not isinstance(e, list) or len(e) < 4:
            continue
        dur = e[2]
        if isinstance(dur, str) and dur.isdigit():
            dur_i = int(dur)
        elif isinstance(dur, int):
            dur_i = dur
        else:
            continue
        argv = e[3]
        if isinstance(argv, list) and argv:
            key = str(argv[0])
        else:
            key = "?"
        row = stats[key]
        row[0] += 1
        row[1] = max(row[1], dur_i)
    if not stats:
        return
    print("=== SLOWLOG top commands (count, max latency µs) ===")
    for cmd, (cnt, mx) in sorted(stats.items(), key=lambda kv: (-kv[1][0], -kv[1][1])):
        print(f"{cmd}\t{cnt}\t{mx}")


def _emit_slowlog(n: int) -> None:
    env, cmd_json = _redis_cli_env_and_argv("SLOWLOG", "GET", str(n), use_json=True)
    try:
        out = subprocess.check_output(cmd_json, env=env, text=True, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"SLOWLOG (--json) failed ({e!r}); falling back to plain redis-cli.", file=sys.stderr)
        env2, cmd_plain = _redis_cli_env_and_argv("SLOWLOG", "GET", str(n), use_json=False)
        os.execvpe(cmd_plain[0], cmd_plain, env2)

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        env2, cmd_plain = _redis_cli_env_and_argv("SLOWLOG", "GET", str(n), use_json=False)
        os.execvpe(cmd_plain[0], cmd_plain, env2)

    if data is None:
        data = []

    _slowlog_emit_summary(data)
    print("=== SLOWLOG raw JSON ===")
    print(out.rstrip())


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "slowlog":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
        if n < 1 or n > 2000:
            print("slowlog N must be 1..2000", file=sys.stderr)
            sys.exit(2)
        _emit_slowlog(n)
        return

    raw = _load_raw_redis_url_from_env()
    print(_sanitize_redis_url(raw) if raw.strip() else DEFAULT)


if __name__ == "__main__":
    main()
