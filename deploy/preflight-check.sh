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

echo "Checking SSH connectivity..."
SSH_OK=0
for attempt in 1 2 3; do
  if ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$SSH_TARGET" "echo ok" >/dev/null 2>&1; then
    SSH_OK=1
    break
  fi
  echo "SSH attempt ${attempt}/3 failed; retrying in 10s..."
  sleep 10
done
if [[ "$SSH_OK" -eq 0 ]]; then
  echo "ERROR: Unable to SSH to ${SSH_TARGET} after 3 attempts."
  echo "Check that port 22 is open in the cloud firewall/security group for this host."
  exit 1
fi

# Run all remaining remote checks in a single SSH session to avoid
# triggering fail2ban with rapid successive connections.
echo "Checking remote runtime prerequisites, nginx config, and health route..."
REMOTE_SCRIPT='set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
command -v nginx >/dev/null
[ -d /opt/chatapp/releases ]
[ -d /opt/chatapp/shared ]
[ -f /opt/chatapp/shared/.env ]
[ -f /etc/nginx/sites-available/chatapp ]
grep -q "/health" /etc/nginx/sites-available/chatapp
sudo nginx -t >/dev/null 2>&1'

if [[ "$ENVIRONMENT" == "prod" ]]; then
  REMOTE_SCRIPT+=$'\ncommand -v pg_dump >/dev/null 2>&1'
  REMOTE_SCRIPT+=$'\nset -a'
  REMOTE_SCRIPT+=$'\nsource /opt/chatapp/shared/.env'
  REMOTE_SCRIPT+=$'\nset +a'
  REMOTE_SCRIPT+=$'case "${DATABASE_URL:-}" in'
  REMOTE_SCRIPT+=$'\n  *:6432*)'
  REMOTE_SCRIPT+=$'\n    if [[ -z "${PGDUMP_DATABASE_URL:-}" ]]; then'
  REMOTE_SCRIPT+=$'\n      echo "ERROR: DATABASE_URL uses PgBouncer (:6432). Set PGDUMP_DATABASE_URL in /opt/chatapp/shared/.env to a direct postgresql:// URL (host:5432) for pg_dump backups."'
  REMOTE_SCRIPT+=$'\n      exit 1'
  REMOTE_SCRIPT+=$'\n    fi'
  REMOTE_SCRIPT+=$'\n    ;;'
  REMOTE_SCRIPT+=$'\nesac'
fi

if ! echo "$REMOTE_SCRIPT" | ssh "$SSH_TARGET" bash -s; then
  echo "ERROR: Remote prerequisite checks failed."
  exit 1
fi

echo "Preflight passed for ${ENVIRONMENT}."
