#!/usr/bin/env bash
# One-shot production health + log snapshot (run from your laptop with SSH access).
# Usage:
#   ./scripts/prod-observe.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 SINCE='4 hours ago' ./scripts/prod-observe.sh
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
SINCE="${SINCE:-2 hours ago}"
SINCE_Q=$(printf '%q' "$SINCE")

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" bash <<EOF
set -euo pipefail
SINCE=${SINCE_Q}
echo "=== \$(date -u) (UTC) | \$(hostname) ==="
echo "=== journal window: --since \$SINCE ==="
echo "=== systemd chatapp@* ==="
systemctl is-active chatapp@4000 chatapp@4001 2>/dev/null || sudo systemctl is-active chatapp@4000 chatapp@4001
echo "=== GET /health (localhost:4000) ==="
curl -fsS -m 5 -H 'Host: group-8.cse356.compas.cs.stonybrook.edu' http://127.0.0.1:4000/health | head -c 500 || echo "curl failed"
echo
echo "=== journal: warnings from app (pino-http 4xx/slow, logger.warn+) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p warning --no-pager -n 30 || true
echo "=== journal: errors (5xx / unhandled / systemd) ==="
sudo journalctl -u 'chatapp@*' --since "\$SINCE" -p err --no-pager -n 20 || true
echo "=== nginx: last [error] lines ==="
sudo grep '[[]error[]]' /var/log/nginx/error.log 2>/dev/null | tail -n 8 || true
EOF
