#!/usr/bin/env bash
# One-shot production health + log snapshot (run from your laptop with SSH access).
# Usage:
#   ./scripts/prod-observe.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 SINCE='4 hours ago' ./scripts/prod-observe.sh
#   PROD_PUBLIC_HOST=group-8.cse356.compas.cs.stonybrook.edu ./scripts/prod-observe.sh
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
PROD_PUBLIC_HOST="${PROD_PUBLIC_HOST:-group-8.cse356.compas.cs.stonybrook.edu}"
SINCE="${SINCE:-2 hours ago}"
SINCE_Q=$(printf '%q' "$SINCE")
PUBLIC_HOST_Q=$(printf '%q' "$PROD_PUBLIC_HOST")

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" bash <<EOF
set -euo pipefail
SINCE=${SINCE_Q}
PUBLIC_HOST=${PUBLIC_HOST_Q}
echo "=== \$(date -u) (UTC) | \$(hostname) ==="
echo "=== journal window: --since \$SINCE ==="
echo "=== systemd chatapp@* ==="
systemctl is-active chatapp@4000 chatapp@4001 2>/dev/null || sudo systemctl is-active chatapp@4000 chatapp@4001
echo "=== GET /health (localhost:4000) ==="
curl -fsS -m 5 -H "Host: \${PUBLIC_HOST}" http://127.0.0.1:4000/health | head -c 500 || echo "curl failed"
echo
echo "=== GET /health (via nginx :80, edge path) ==="
curl -fsS -m 5 -H "Host: \${PUBLIC_HOST}" http://127.0.0.1/health | head -c 500 || echo "curl edge failed"
echo
echo "=== nginx access: recent 502/503 (last ~2000 lines) ==="
sudo tail -n 2000 /var/log/nginx/access.log 2>/dev/null | grep -E ' (502|503) ' | tail -n 15 || true
echo "=== journal: warnings from app (pino-http 4xx/slow, logger.warn+) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p warning --no-pager -n 30 || true
echo "=== journal: errors (5xx / unhandled / systemd) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p err --no-pager -n 20 || true
echo "=== nginx: last [error] lines ==="
sudo grep '[[]error[]]' /var/log/nginx/error.log 2>/dev/null | tail -n 8 || true
EOF
