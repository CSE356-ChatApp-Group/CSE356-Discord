#!/usr/bin/env bash
# Production nginx + chatapp upstream audit (run from laptop with SSH).
# Checks: chatapp@4000/4001 active, upstream app lists 4000+4001, nginx -t.
# Dual upstreams should use max_fails>0 (e.g. max_fails=2) so dead peers can be marked down.
#
# Usage:
#   ./scripts/prod-nginx-audit.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 ./scripts/prod-nginx-audit.sh
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" bash <<'REMOTE'
set -euo pipefail
echo "=== $(date -u) (UTC) | $(hostname) ==="
echo "=== systemd chatapp@4000 chatapp@4001 ==="
systemctl is-active chatapp@4000 chatapp@4001 2>/dev/null || true
systemctl show -p ActiveState,SubState,Result chatapp@4000 chatapp@4001 2>/dev/null | paste - - || true
echo "=== upstream app block (sites-available/chatapp) ==="
if sudo test -f /etc/nginx/sites-available/chatapp; then
  sudo sed -n '/^upstream app {/,/^}/p' /etc/nginx/sites-available/chatapp
else
  echo "MISSING /etc/nginx/sites-available/chatapp"
  exit 1
fi
echo "=== checks: two distinct ports 4000 and 4001; server lines declare max_fails ==="
UPSTREAM=$(sudo sed -n '/^upstream app {/,/^}/p' /etc/nginx/sites-available/chatapp)
if echo "$UPSTREAM" | grep -q 'server.*4000' && echo "$UPSTREAM" | grep -q 'server.*4001'; then
  echo "OK: found server lines for 4000 and 4001"
else
  echo "WARN: expected both localhost/127.0.0.1 :4000 and :4001 in upstream app (dual-worker prod)"
fi
if echo "$UPSTREAM" | grep -E '^\s*server\s+' | grep -v 'max_fails=' | grep -q .; then
  echo "WARN: some upstream server lines lack max_fails= (unexpected)"
else
  echo "OK: each server line includes max_fails (or no server lines matched)"
fi
if echo "$UPSTREAM" | grep -qF 'max_fails=0'; then
  srv_n=$(echo "$UPSTREAM" | grep -cE '^\s*server\s+' || true)
  if [[ "${srv_n}" -ge 2 ]]; then
    echo "WARN: dual upstream uses max_fails=0 — peers are never marked down (see deploy-prod.sh 9c)"
  fi
fi
DUP=$(echo "$UPSTREAM" | grep -oE 'localhost:[0-9]+|127\.0\.0\.1:[0-9]+' | sort | uniq -d || true)
if [[ -n "$DUP" ]]; then
  echo "FAIL: duplicate upstream ports: $DUP"
  exit 1
fi
# If both Node workers are running, nginx must load-balance both (avoids single point + mis-cutover).
if systemctl is-active --quiet chatapp@4000 2>/dev/null && systemctl is-active --quiet chatapp@4001 2>/dev/null; then
  if ! echo "$UPSTREAM" | grep -qE ':(4000)\b' || ! echo "$UPSTREAM" | grep -qE ':(4001)\b'; then
    echo "FAIL: chatapp@4000 and chatapp@4001 are active but upstream app must list BOTH ports 4000 and 4001"
    exit 1
  fi
  echo "OK: dual workers active and nginx lists 4000 + 4001"
fi
echo "=== nginx -t ==="
sudo nginx -t
echo "=== audit finished OK ==="
REMOTE
