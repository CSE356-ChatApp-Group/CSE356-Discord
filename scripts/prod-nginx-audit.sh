#!/usr/bin/env bash
# Production nginx + chatapp upstream audit (run from laptop with SSH).
# Checks: every *active* chatapp@4000+ unit appears in upstream app; nginx -t.
# Supports dual-worker (4000+4001) and multi-worker (e.g. 4000–4003).
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

ACTIVE_PORTS=()
for p in $(seq 4000 4007); do
  if systemctl is-active --quiet "chatapp@${p}" 2>/dev/null; then
    ACTIVE_PORTS+=("$p")
  fi
done

if [[ "${#ACTIVE_PORTS[@]}" -eq 0 ]]; then
  echo "WARN: no active chatapp@4000–4007 units found"
else
  echo "=== active chatapp units ==="
  for p in "${ACTIVE_PORTS[@]}"; do
    systemctl show -p Id,ActiveState,SubState "chatapp@${p}" 2>/dev/null | paste - - || true
  done
fi

echo "=== upstream app block (sites-available/chatapp) ==="
if sudo test -f /etc/nginx/sites-available/chatapp; then
  sudo sed -n '/^upstream app {/,/^}/p' /etc/nginx/sites-available/chatapp
else
  echo "MISSING /etc/nginx/sites-available/chatapp"
  exit 1
fi

UPSTREAM=$(sudo sed -n '/^upstream app {/,/^}/p' /etc/nginx/sites-available/chatapp)

if echo "$UPSTREAM" | grep -qE '^\s*least_conn\s*;'; then
  echo "OK: upstream uses least_conn"
else
  echo "WARN: least_conn not present (optional for single-backend)"
fi

if echo "$UPSTREAM" | grep -E '^\s*server\s+' | grep -v 'max_fails=' | grep -q .; then
  echo "WARN: some upstream server lines lack max_fails= (unexpected)"
else
  echo "OK: each server line includes max_fails (or no server lines matched)"
fi

if echo "$UPSTREAM" | grep -qF 'max_fails=0'; then
  srv_n=$(echo "$UPSTREAM" | grep -cE '^\s*server\s+' || true)
  if [[ "${srv_n}" -ge 2 ]]; then
    echo "WARN: multi-upstream uses max_fails=0 — peers are never marked down (see deploy-prod.sh 9c)"
  fi
fi

PORTS_UP=$(echo "$UPSTREAM" | grep -oE 'localhost:[0-9]+|127\.0\.0\.1:[0-9]+' | sed 's/.*://' | sort -u)
DUP=$(echo "$UPSTREAM" | grep -oE 'localhost:[0-9]+|127\.0\.0\.1:[0-9]+' | sort | uniq -d || true)
if [[ -n "$DUP" ]]; then
  echo "FAIL: duplicate upstream ports: $DUP"
  exit 1
fi

# Every active Node worker must be listed in upstream (steady state after deploy).
for p in "${ACTIVE_PORTS[@]}"; do
  if ! echo "$PORTS_UP" | grep -qx "$p"; then
    echo "FAIL: chatapp@${p} is active but upstream app does not list port ${p} (upstream ports: $(echo "$PORTS_UP" | tr '\n' ' '))"
    exit 1
  fi
done

# Every upstream port must also correspond to an active worker; otherwise nginx
# can route traffic into a dead candidate or stale instance.
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  found=0
  for active in "${ACTIVE_PORTS[@]}"; do
    if [[ "$active" == "$p" ]]; then
      found=1
      break
    fi
  done
  if [[ "$found" -ne 1 ]]; then
    echo "FAIL: upstream app lists port ${p} but chatapp@${p} is not active (active ports: ${ACTIVE_PORTS[*]:-none})"
    exit 1
  fi
done <<< "$PORTS_UP"

if [[ "${#ACTIVE_PORTS[@]}" -ge 2 ]]; then
  echo "OK: ${#ACTIVE_PORTS[@]} workers active and nginx upstream matches them exactly (${ACTIVE_PORTS[*]})"
fi

echo "=== nginx -t ==="
sudo nginx -t
echo "=== audit finished OK ==="
REMOTE
