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

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "prod" ]]; then
  echo "ERROR: environment must be 'staging' or 'prod'"
  exit 1
fi

echo "=== Preflight: ${ENVIRONMENT} ==="
echo "Target: ${SSH_USER}@${SSH_HOST}"

for cmd in gh ssh scp curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $cmd"
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

echo "Checking release artifact exists..."
if ! gh release view "release-${RELEASE_SHA}" -R "$GITHUB_REPO" >/dev/null 2>&1; then
  echo "ERROR: Release release-${RELEASE_SHA} not found in ${GITHUB_REPO}"
  exit 1
fi

SSH_TARGET="${SSH_USER}@${SSH_HOST}"

echo "Checking SSH connectivity..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_TARGET" "echo ok" >/dev/null 2>&1; then
  echo "ERROR: Unable to SSH to ${SSH_TARGET}."
  echo "If this is first connection, run: ssh ${SSH_TARGET}"
  exit 1
fi

echo "Checking remote runtime prerequisites..."
ssh "$SSH_TARGET" "
  set -euo pipefail
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v nginx >/dev/null
  [ -d /opt/chatapp/releases ]
  [ -d /opt/chatapp/shared ]
  [ -f /opt/chatapp/shared/.env ]
  [ -f /etc/nginx/sites-available/chatapp ]
"

echo "Checking remote /health route path compatibility in nginx config..."
ssh "$SSH_TARGET" "grep -q '/health' /etc/nginx/sites-available/chatapp"

echo "Checking nginx config validity..."
if ! ssh "$SSH_TARGET" "sudo nginx -t >/dev/null 2>&1"; then
  echo "ERROR: nginx -t failed on remote host. Fix nginx config before deploy."
  exit 1
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
  echo "Checking pg_dump availability for production backup..."
  if ! ssh "$SSH_TARGET" "command -v pg_dump >/dev/null 2>&1"; then
    echo "ERROR: pg_dump not available on production host."
    exit 1
  fi
fi

echo "Preflight passed for ${ENVIRONMENT}."
