#!/usr/bin/bash
set -e

REDIS_URL=$(grep "^REDIS_URL=" /opt/chatapp/shared/.env | cut -d= -f2- | tr -d '\r\n')
HOST=$(python3 -c "import urllib.parse,sys; u=urllib.parse.urlparse(sys.argv[1]); print(u.hostname or '127.0.0.1')" "$REDIS_URL")
PORT=$(python3 -c "import urllib.parse,sys; u=urllib.parse.urlparse(sys.argv[1]); print(u.port or 6379)" "$REDIS_URL")

for i in $(seq 1 30); do
  (echo > /dev/tcp/$HOST/$PORT) >/dev/null 2>&1 && exit 0
  sleep 1
done

(echo > /dev/tcp/$HOST/$PORT) >/dev/null 2>&1
