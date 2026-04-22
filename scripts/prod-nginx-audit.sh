#!/usr/bin/env bash
# Production nginx + chatapp upstream audit (run from laptop with SSH).
# Checks:
#   - exact 14-worker 3-VM upstream topology (VM1=4, VM2=5, VM3=5)
#   - required proxy retry policy includes http_503 + non_idempotent
#   - nginx -t succeeds
#
# Usage:
#   ./scripts/prod-nginx-audit.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 ./scripts/prod-nginx-audit.sh
set -euo pipefail
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
PRIMARY_VM1_HOST="130.245.136.44"

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" "PROD_HOST='${PROD_HOST}' PRIMARY_VM1_HOST='${PRIMARY_VM1_HOST}' bash" <<'REMOTE'
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

SITE=/etc/nginx/sites-available/chatapp
UPSTREAM=$(sudo sed -n '/^upstream app {/,/^}/p' "${SITE}")

if echo "$UPSTREAM" | grep -qE '^\s*least_conn\s*;'; then
  echo "OK: upstream uses least_conn"
elif echo "$UPSTREAM" | grep -qE '^\s*round_robin\s*;'; then
  echo "FAIL: round_robin is not a valid nginx directive (remove it; default is round-robin)"
  exit 1
elif echo "$UPSTREAM" | grep -qE '^\s*server\s+'; then
  echo "OK: upstream uses implicit round-robin (no explicit balance directive)"
else
  echo "FAIL: upstream has no recognized load-balancing / server configuration"
  exit 1
fi

if echo "$UPSTREAM" | grep -E '^\s*server\s+' | grep -v 'max_fails=' | grep -q .; then
  echo "FAIL: some upstream server lines lack max_fails= (unexpected)"
  exit 1
else
  echo "OK: each server line includes max_fails (or no server lines matched)"
fi

EXPECTED_SERVERS=(
  "localhost:4000"
  "localhost:4001"
  "localhost:4002"
  "localhost:4003"
  "10.0.3.243:4000"
  "10.0.3.243:4001"
  "10.0.3.243:4002"
  "10.0.3.243:4003"
  "10.0.3.243:4004"
  "10.0.3.243:4005"
  "10.0.2.164:4000"
  "10.0.2.164:4001"
  "10.0.2.164:4002"
  "10.0.2.164:4003"
  "10.0.2.164:4004"
  "10.0.2.164:4005"
)

SERVER_LINES=$(echo "$UPSTREAM" | grep -oE 'server[[:space:]]+[^[:space:];]+' | awk '{print $2}')
DUP=$(echo "$SERVER_LINES" | sort | uniq -d || true)
if [[ -n "${DUP}" ]]; then
  echo "FAIL: duplicate upstream servers: ${DUP}"
  exit 1
fi

if [[ "${PROD_HOST}" == "${PRIMARY_VM1_HOST}" ]]; then
  # VM1 (shared ingress): enforce full 14-worker cross-VM topology.
  for s in "${EXPECTED_SERVERS[@]}"; do
    if ! echo "${SERVER_LINES}" | grep -qx "${s}"; then
      echo "FAIL: upstream app missing expected server ${s}"
      exit 1
    fi
  done
  while IFS= read -r s; do
    [[ -n "${s}" ]] || continue
    found=0
    for exp in "${EXPECTED_SERVERS[@]}"; do
      if [[ "${exp}" == "${s}" ]]; then
        found=1
        break
      fi
    done
    if [[ "${found}" -ne 1 ]]; then
      echo "FAIL: upstream app has unexpected server ${s}"
      exit 1
    fi
  done <<< "${SERVER_LINES}"
  echo "OK: upstream includes expected 16 worker server entries (4+6+6)"

  # VM1 local workers (localhost:4000-4003) must be active.
  for p in 4000 4001 4002 4003; do
    if ! systemctl is-active --quiet "chatapp@${p}" 2>/dev/null; then
      echo "FAIL: expected local worker chatapp@${p} is not active"
      exit 1
    fi
  done
  echo "OK: VM1 local workers 4000-4003 are active"
else
  # VM2/VM3 workers-only: enforce local upstream matches active local units.
  LOCAL_UP=$(echo "${SERVER_LINES}" | grep -E '^localhost:' || true)
  if [[ -z "${LOCAL_UP}" ]]; then
    echo "FAIL: no localhost upstream servers found on workers-only host"
    exit 1
  fi
  while IFS= read -r s; do
    [[ -n "${s}" ]] || continue
    p="${s#localhost:}"
    if ! systemctl is-active --quiet "chatapp@${p}" 2>/dev/null; then
      echo "FAIL: upstream lists ${s} but chatapp@${p} is not active"
      exit 1
    fi
  done <<< "${LOCAL_UP}"
  echo "OK: worker-host local upstream matches active local chatapp units"
fi

# Required retry policy now includes http_503 + non_idempotent and tries=2.
RETRY_LINE='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
TRIES_LINE='proxy_next_upstream_tries 2;'
if sudo grep -Fq "${RETRY_LINE}" "${SITE}"; then
  echo "OK: proxy_next_upstream includes http_503 + non_idempotent"
else
  echo "FAIL: missing '${RETRY_LINE}' in ${SITE}"
  exit 1
fi
if sudo grep -Fq "${TRIES_LINE}" "${SITE}"; then
  echo "OK: proxy_next_upstream_tries 2 is present"
else
  echo "FAIL: missing '${TRIES_LINE}' in ${SITE}"
  exit 1
fi

echo "=== nginx -t ==="
sudo nginx -t
echo "=== audit finished OK ==="
REMOTE
