#!/usr/bin/env bash
# Production nginx + chatapp upstream audit (run from laptop with SSH).
# Checks:
#   - exact 16-worker 3-VM upstream topology (VM1=4, VM2=6, VM3=6)
#   - required proxy retry policy includes http_503 + non_idempotent
#   - nginx -t succeeds
#
# Usage:
#   ./scripts/ops/prod-nginx-audit.sh
#   PROD_USER=ubuntu PROD_HOST=130.245.136.44 ./scripts/ops/prod-nginx-audit.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolve_repo_root() {
  local dir="${SCRIPT_DIR}"
  while [[ "${dir}" != "/" ]]; do
    if [[ -f "${dir}/deploy/inventory-defaults.sh" ]]; then
      printf '%s\n' "${dir}"
      return 0
    fi
    dir="$(dirname "${dir}")"
  done
  return 1
}

REPO_ROOT="$(resolve_repo_root || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  echo "ERROR: could not locate repo root containing deploy/inventory-defaults.sh" >&2
  exit 1
fi

# shellcheck source=../../deploy/inventory-defaults.sh
# shellcheck disable=SC1091
source "${REPO_ROOT}/deploy/inventory-defaults.sh"
PROD_HOST="${PROD_HOST:-130.245.136.44}"
PROD_USER="${PROD_USER:-ubuntu}"
PRIMARY_VM1_HOST="130.245.136.44"
WSVM1_INTERNAL="${WSVM1_INTERNAL:-${CHATAPP_INV_WSVM1_INTERNAL}}"
WSVM2_INTERNAL="${WSVM2_INTERNAL:-${CHATAPP_INV_WSVM2_INTERNAL}}"
WSVM1_WORKERS="${WSVM1_WORKERS:-${CHATAPP_INV_WSVM1_WORKERS}}"
WSVM2_WORKERS="${WSVM2_WORKERS:-${CHATAPP_INV_WSVM2_WORKERS}}"
WS_TIER_ENABLED="${WS_TIER_ENABLED:-${CHATAPP_INV_WS_TIER_ENABLED}}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "${PROD_USER}@${PROD_HOST}" "PROD_HOST='${PROD_HOST}' PRIMARY_VM1_HOST='${PRIMARY_VM1_HOST}' WSVM1_INTERNAL='${WSVM1_INTERNAL}' WSVM2_INTERNAL='${WSVM2_INTERNAL}' WSVM1_WORKERS='${WSVM1_WORKERS}' WSVM2_WORKERS='${WSVM2_WORKERS}' WS_TIER_ENABLED='${WS_TIER_ENABLED}' bash" <<'REMOTE'
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
WS_UPSTREAM=$(sudo sed -n '/^upstream app_ws {/,/^}/p' "${SITE}" || true)
WS_LOCATION=$(sudo sed -n '/location \/ws {/,/^}/p' "${SITE}" || true)

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

  if [[ -n "${WS_UPSTREAM}" ]]; then
    echo "=== upstream app_ws block (sites-available/chatapp) ==="
    printf '%s\n' "${WS_UPSTREAM}"
    if ! grep -Fq 'hash $ws_sticky_key consistent;' <<< "${WS_UPSTREAM}"; then
      echo "FAIL: upstream app_ws is missing sticky hash on \$ws_sticky_key"
      exit 1
    fi
    if ! grep -Fq 'proxy_pass http://app_ws;' <<< "${WS_LOCATION}"; then
      echo "FAIL: /ws is not routed to upstream app_ws"
      exit 1
    fi
    if ! grep -Fq '/var/log/nginx/ws_access.log chatapp_ws;' <<< "${WS_LOCATION}"; then
      echo "FAIL: /ws is missing dedicated websocket access_log"
      exit 1
    fi
    WS_EXPECTED_SERVERS=()
    if [[ "${WS_TIER_ENABLED:-false}" == "true" ]] && [[ -n "${WSVM1_INTERNAL:-}" ]] && [[ "${WSVM1_WORKERS:-0}" -gt 0 ]]; then
      for ((p=4000; p<4000 + WSVM1_WORKERS; p++)); do
        WS_EXPECTED_SERVERS+=("${WSVM1_INTERNAL}:${p}")
      done
    fi
    if [[ "${WS_TIER_ENABLED:-false}" == "true" ]] && [[ -n "${WSVM2_INTERNAL:-}" ]] && [[ "${WSVM2_WORKERS:-0}" -gt 0 ]]; then
      for ((p=4000; p<4000 + WSVM2_WORKERS; p++)); do
        WS_EXPECTED_SERVERS+=("${WSVM2_INTERNAL}:${p}")
      done
    fi
    if [[ "${#WS_EXPECTED_SERVERS[@]}" -gt 0 ]]; then
      WS_SERVER_LINES=$(echo "${WS_UPSTREAM}" | grep -oE 'server[[:space:]]+[^[:space:];]+' | awk '{print $2}')
      for s in "${WS_EXPECTED_SERVERS[@]}"; do
        if ! echo "${WS_SERVER_LINES}" | grep -qx "${s}"; then
          echo "FAIL: upstream app_ws missing expected websocket server ${s}"
          exit 1
        fi
      done
      while IFS= read -r s; do
        [[ -n "${s}" ]] || continue
        found=0
        for exp in "${WS_EXPECTED_SERVERS[@]}"; do
          if [[ "${exp}" == "${s}" ]]; then
            found=1
            break
          fi
        done
        if [[ "${found}" -ne 1 ]]; then
          echo "FAIL: upstream app_ws has unexpected server ${s}"
          exit 1
        fi
      done <<< "${WS_SERVER_LINES}"
      if echo "${WS_SERVER_LINES}" | grep -q '^localhost:'; then
        echo "FAIL: upstream app_ws should not include localhost workers when dedicated WSVMs are configured"
        exit 1
      fi
      echo "OK: upstream app_ws matches dedicated websocket VMs only"
    fi
    echo "OK: /ws routes to app_ws with dedicated websocket logging"
  fi
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

# Required retry policy includes http_503 + non_idempotent on /api/.
# proxy_next_upstream_tries must be 0 (unlimited within upstream group) for multi-VM:
# with tries=2 and 16 workers, rolling deploys often hit two dead peers in a row →
# connect() failed (111: Connection refused) and client-visible failures despite healthy peers.
RETRY_LINE='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
TRIES_LINE='proxy_next_upstream_tries 0;'
if sudo grep -Fq "${RETRY_LINE}" "${SITE}"; then
  echo "OK: proxy_next_upstream includes http_503 + non_idempotent"
else
  echo "FAIL: missing '${RETRY_LINE}' in ${SITE}"
  exit 1
fi
if sudo grep -Fq "${TRIES_LINE}" "${SITE}"; then
  echo "OK: proxy_next_upstream_tries 0 is present (multi-upstream safe)"
else
  echo "FAIL: missing '${TRIES_LINE}' in ${SITE}"
  exit 1
fi

echo "=== nginx -t ==="
sudo nginx -t
echo "=== audit finished OK ==="
REMOTE
