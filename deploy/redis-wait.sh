#!/usr/bin/env bash
set -euo pipefail

REDIS_URL=$(grep "^REDIS_URL=" /opt/chatapp/shared/.env | tail -1 | cut -d= -f2- | tr -d '\r\n')

python3 - "$REDIS_URL" <<'PY'
import socket
import sys
import time
import urllib.parse

url = urllib.parse.urlparse(sys.argv[1])
host = url.hostname or "127.0.0.1"
port = url.port or 6379
username = urllib.parse.unquote(url.username or "")
password = urllib.parse.unquote(url.password or "")


def encode_resp(parts: list[str]) -> bytes:
    out = [f"*{len(parts)}\r\n".encode()]
    for part in parts:
        data = part.encode()
        out.append(f"${len(data)}\r\n".encode())
        out.append(data)
        out.append(b"\r\n")
    return b"".join(out)


def read_line(sock: socket.socket) -> bytes:
    data = b""
    while not data.endswith(b"\r\n"):
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("redis closed connection")
        data += chunk
    return data


last_error = "redis not checked"
for _ in range(30):
    try:
        with socket.create_connection((host, port), timeout=2) as sock:
            sock.settimeout(2)
            if password:
                auth_parts = ["AUTH", username, password] if username else ["AUTH", password]
                sock.sendall(encode_resp(auth_parts))
                auth_reply = read_line(sock)
                if not auth_reply.startswith(b"+OK"):
                    raise RuntimeError("redis AUTH failed")
            sock.sendall(encode_resp(["PING"]))
            ping_reply = read_line(sock)
            if ping_reply.startswith(b"+PONG"):
                sys.exit(0)
            raise RuntimeError("redis PING failed")
    except Exception as exc:
        last_error = str(exc)
        time.sleep(1)

raise SystemExit(f"Redis readiness check failed for {host}:{port}: {last_error}")
PY
