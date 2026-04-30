#!/bin/bash
# deploy/preflight-check.sh
# Usage:
#   ./preflight-check.sh <staging|prod> <release_sha> <ssh_user> <ssh_host> <github_repo>

set -euo pipefail

ENVIRONMENT=${1:?environment required: staging|prod}
RELEASE_SHA=${2:?release sha required}
SSH_USER=${3:?ssh user required}
SSH_HOST=${4:?ssh host required}
GITHUB_REPO=${5:?github repo required}
LOCAL_ARTIFACT_PATH=${LOCAL_ARTIFACT_PATH:-}
_PREFLIGHT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-common.sh
# shellcheck disable=SC1091
source "${_PREFLIGHT_SCRIPT_DIR}/deploy-common.sh"

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "prod" ]]; then
  echo "ERROR: environment must be 'staging' or 'prod'"
  exit 1
fi

echo "=== Preflight: ${ENVIRONMENT} ==="
echo "Target: ${SSH_USER}@${SSH_HOST}"

REQUIRED_COMMANDS=(ssh scp curl)
if [[ -z "$LOCAL_ARTIFACT_PATH" ]]; then
  REQUIRED_COMMANDS=(gh "${REQUIRED_COMMANDS[@]}")
fi

for cmd in "${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $cmd"
    exit 1
  fi
done

if [[ -n "$LOCAL_ARTIFACT_PATH" ]]; then
  echo "Using local artifact: ${LOCAL_ARTIFACT_PATH}"
  if [[ ! -f "$LOCAL_ARTIFACT_PATH" ]]; then
    echo "ERROR: Local artifact not found at ${LOCAL_ARTIFACT_PATH}"
    exit 1
  fi
else
  if [[ -n "${GH_TOKEN:-}" || -n "${GITHUB_TOKEN:-}" ]]; then
    echo "Using GitHub token from environment for gh commands."
  elif ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated. Run: gh auth login"
    exit 1
  fi

  echo "Checking release artifact exists..."
  if ! gh release view "release-${RELEASE_SHA}" -R "$GITHUB_REPO" >/dev/null 2>&1; then
    echo "ERROR: Release release-${RELEASE_SHA} not found in ${GITHUB_REPO}"
    exit 1
  fi
fi

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
PREFLIGHT_SSH_ATTEMPTS="${PREFLIGHT_SSH_ATTEMPTS:-6}"
PREFLIGHT_SSH_RETRY_DELAY_SECS="${PREFLIGHT_SSH_RETRY_DELAY_SECS:-10}"
PREFLIGHT_SSH_CONNECT_TIMEOUT_SECS="${PREFLIGHT_SSH_CONNECT_TIMEOUT_SECS:-20}"

echo "Checking SSH connectivity..."
SSH_OK=0
_PREFLIGHT_SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout="${PREFLIGHT_SSH_CONNECT_TIMEOUT_SECS}"
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
)
if [[ -n "${DEPLOY_SSH_EXTRA_OPTS:-}" ]]; then
  # shellcheck disable=SC2206 # split like shell args, e.g. "-o StrictHostKeyChecking=accept-new"
  _DEPLOY_SSH_EXTRA_ARR=( ${DEPLOY_SSH_EXTRA_OPTS} )
  _PREFLIGHT_SSH_OPTS+=( "${_DEPLOY_SSH_EXTRA_ARR[@]}" )
fi
for attempt in $(seq 1 "${PREFLIGHT_SSH_ATTEMPTS}"); do
  if ssh "${_PREFLIGHT_SSH_OPTS[@]}" "$SSH_TARGET" "echo ok" >/dev/null 2>&1; then
    SSH_OK=1
    break
  fi
  if [[ "${attempt}" -lt "${PREFLIGHT_SSH_ATTEMPTS}" ]]; then
    echo "SSH attempt ${attempt}/${PREFLIGHT_SSH_ATTEMPTS} failed; retrying in ${PREFLIGHT_SSH_RETRY_DELAY_SECS}s..."
    sleep "${PREFLIGHT_SSH_RETRY_DELAY_SECS}"
  fi
done
if [[ "$SSH_OK" -eq 0 ]]; then
  echo "ERROR: Unable to SSH to ${SSH_TARGET} after ${PREFLIGHT_SSH_ATTEMPTS} attempts."
  echo "Check that port 22 is open in the cloud firewall/security group for this host."
  exit 1
fi

# Run all remaining remote checks in a single SSH session to avoid
# triggering fail2ban with rapid successive connections.
echo "Checking remote runtime prerequisites, nginx config, and health route..."
# Use quoted heredocs (not $'...\nset +a...'): in ANSI-C quotes, "\c" ends the string, so
# $'\nset +a' is parsed as newline + "set " + "\c" — the "+a" corrupts the remote script and
# bash reports: set: +c: invalid option.
# Read DATABASE_URL / PGDUMP_DATABASE_URL with grep instead of sourcing .env (safer).
{
  # Unquoted delimiter so ${CHATAPP_NGINX_SITE_PATH} is expanded locally into the remote script.
  cat <<REMOTE_BASE
set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
command -v nginx >/dev/null
[ -d /opt/chatapp/releases ]
[ -d /opt/chatapp/shared ]
[ -f /opt/chatapp/shared/.env ]
[ -f "${CHATAPP_NGINX_SITE_PATH}" ]
grep -q "/health" "${CHATAPP_NGINX_SITE_PATH}"
SITE=${CHATAPP_NGINX_SITE_PATH}
if ! sudo nginx -t 2>/tmp/chatapp_nginx_t.err; then
  cat /tmp/chatapp_nginx_t.err >&2 || true
  # One-shot heal: standalone proxy_next_upstream_non_idempotent is invalid on stock nginx;
  # POST retry uses the non_idempotent keyword on proxy_next_upstream (idempotent sed).
  if grep -q "proxy_next_upstream_non_idempotent" "\$SITE" 2>/dev/null; then
    echo "Preflight: removing invalid proxy_next_upstream_non_idempotent from \$SITE..." >&2
    sudo sed -i '/proxy_next_upstream_non_idempotent/d' "\$SITE"
  fi
  echo "Preflight: normalizing proxy_next_upstream retry line in \$SITE..." >&2
  sudo sed -i \
    "s|${CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY}|${CHATAPP_NGINX_PROXY_RETRY_LINE}|g" \
    "\$SITE"
  if ! sudo nginx -t; then
    echo "ERROR: nginx -t still failing after heal attempt; fix \$SITE manually." >&2
    exit 1
  fi
  echo "Preflight: nginx config healed (reload happens during deploy)." >&2
fi
REMOTE_BASE
  if [[ "$ENVIRONMENT" == "prod" ]]; then
    cat <<'REMOTE_PROD'
command -v pg_dump >/dev/null 2>&1
DATABASE_URL_VAL=$(grep -E '^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=' /opt/chatapp/shared/.env | tail -1 | cut -d= -f2- | tr -d '\r')
PGDUMP_URL_VAL=$(grep -E '^[[:space:]]*(export[[:space:]]+)?PGDUMP_DATABASE_URL=' /opt/chatapp/shared/.env | tail -1 | cut -d= -f2- | tr -d '\r')
case "$DATABASE_URL_VAL" in
  *:6432*)
    if [[ -z "$PGDUMP_URL_VAL" ]]; then
      echo "ERROR: DATABASE_URL uses PgBouncer (:6432). Set PGDUMP_DATABASE_URL in /opt/chatapp/shared/.env to a direct postgresql:// URL (host:5432) for pg_dump backups."
      exit 1
    fi
    ;;
esac
REMOTE_PROD
  fi
} | ssh "${_PREFLIGHT_SSH_OPTS[@]}" "$SSH_TARGET" bash -s || {
  echo "ERROR: Remote prerequisite checks failed."
  exit 1
}

echo "Preflight passed for ${ENVIRONMENT}."
