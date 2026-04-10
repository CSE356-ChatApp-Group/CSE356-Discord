#!/usr/bin/env bash
# Pull recent nginx access.log from prod (or staging) and summarize grader-like traffic.
# Usage:
#   ./scripts/scan-prod-grader-traffic.sh
#   PROD_HOST=130.245.136.44 TAIL_LINES=300000 ./scripts/scan-prod-grader-traffic.sh
#   ./scripts/scan-prod-grader-traffic.sh --no-hint   # all clients, not only 10.x / node UA
set -euo pipefail
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
TAIL_LINES="${TAIL_LINES:-400000}"
HINT=1
if [[ "${1:-}" == "--no-hint" ]]; then
  HINT=0
  shift || true
fi

PY_ARGS=()
if [[ "$HINT" -eq 1 ]]; then
  PY_ARGS+=(--hint-grader)
fi

ssh -o BatchMode=yes -o ConnectTimeout=20 "${PROD_USER}@${PROD_HOST}" \
  "sudo tail -n ${TAIL_LINES} /var/log/nginx/access.log" \
  | python3 "${ROOT}/scripts/analyze-nginx-grader-traffic.py" "${PY_ARGS[@]}"
