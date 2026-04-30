#!/usr/bin/env bash
# Push DEPLOY_SSH_KEY and optional SSH_KNOWN_HOSTS to GitHub for Actions VM deploys
# (see .github/workflows/reusable-vm-deploy.yml and deploy/README.md).
#
# Prerequisites: gh auth login, admin on the repo, environments "production" and
# "staging" created if you use --env (recommended so keys can differ per target).
#
# Examples:
#   ./scripts/ops/gh-set-deploy-ssh-secrets.sh --key ~/.ssh/chatapp-deploy.ed25519 \
#     --scan-hosts "136.114.103.71" --env staging
#
#   ./scripts/ops/gh-set-deploy-ssh-secrets.sh --key ~/.ssh/chatapp-deploy.ed25519 \
#     --scan-hosts "130.245.136.44,130.245.136.21" --env production
#   (second host is PROD_DB_HOST when app and DB are different IPs — deploy-prod.sh
#    SCPs to both; the reusable workflow only keyscans the primary host otherwise.)
#
#   ./scripts/ops/gh-set-deploy-ssh-secrets.sh --key ~/.ssh/key --known-hosts ./kh.txt --env all

set -euo pipefail

usage() {
  cat <<'EOF'
Push DEPLOY_SSH_KEY and optional SSH_KNOWN_HOSTS to GitHub for Actions VM deploys.

Options:
  --key PATH              Private key file (required)
  --repo OWNER/NAME       Default: current repo (gh repo view)
  --scan-hosts H1,H2,...  Build SSH_KNOWN_HOSTS via ssh-keyscan -H (optional)
  --known-hosts PATH      Use this file as SSH_KNOWN_HOSTS instead of --scan-hosts
  --env NAME              production | staging | all | repo
                          production/staging: GitHub Environment secrets (-e)
                          all: set both environments (same key + known_hosts)
                          repo: repository-level secrets only (no -e)
  --dry-run               Print gh commands instead of running them

If neither --scan-hosts nor --known-hosts is given, only DEPLOY_SSH_KEY is updated.
EOF
}

KEY_FILE=""
REPO=""
SCAN_HOSTS=""
KNOWN_HOSTS_FILE=""
ENV_TARGET=""
DRY_RUN=0
TMP_KNOWN=""

cleanup() {
  if [[ -n "$TMP_KNOWN" && -f "$TMP_KNOWN" ]]; then
    rm -f "$TMP_KNOWN"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)
      KEY_FILE="${2:?}"
      shift 2
      ;;
    --repo)
      REPO="${2:?}"
      shift 2
      ;;
    --scan-hosts)
      SCAN_HOSTS="${2:?}"
      shift 2
      ;;
    --known-hosts)
      KNOWN_HOSTS_FILE="${2:?}"
      shift 2
      ;;
    --env)
      ENV_TARGET="${2:?}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$KEY_FILE" ]]; then
  echo "Missing --key PATH" >&2
  usage >&2
  exit 2
fi
if [[ ! -f "$KEY_FILE" ]]; then
  echo "Key file not found: $KEY_FILE" >&2
  exit 1
fi
if [[ -n "$SCAN_HOSTS" && -n "$KNOWN_HOSTS_FILE" ]]; then
  echo "Use only one of --scan-hosts or --known-hosts" >&2
  exit 2
fi
if [[ -z "$ENV_TARGET" ]]; then
  echo "Missing --env (production | staging | all | repo)" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is not installed (https://cli.github.com/)" >&2
  exit 1
fi
if [[ "$DRY_RUN" -eq 0 ]] && ! gh auth status >/dev/null 2>&1; then
  echo "Not logged in: gh auth login" >&2
  exit 1
fi

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

if [[ -n "$SCAN_HOSTS" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Note: --dry-run skips ssh-keyscan; SSH_KNOWN_HOSTS is not updated. Use --known-hosts or re-run without --dry-run." >&2
  else
    TMP_KNOWN="$(mktemp)"
    IFS=',' read -r -a HOST_ARR <<< "$SCAN_HOSTS"
    for h in "${HOST_ARR[@]}"; do
      h="${h#"${h%%[![:space:]]*}"}"
      h="${h%"${h##*[![:space:]]}"}"
      [[ -z "$h" ]] && continue
      echo "ssh-keyscan -H $h" >&2
      ssh-keyscan -T 20 -H "$h" >>"$TMP_KNOWN" || {
        echo "ssh-keyscan failed for: $h" >&2
        exit 1
      }
    done
    [[ -s "$TMP_KNOWN" ]] || {
      echo "known_hosts would be empty" >&2
      exit 1
    }
    KNOWN_HOSTS_FILE="$TMP_KNOWN"
  fi
fi

run_gh() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

set_key_for_env() {
  local env_flag=()
  if [[ -n "$1" ]]; then
    env_flag=(--env "$1")
  fi
  run_gh gh secret set DEPLOY_SSH_KEY --repo "$REPO" "${env_flag[@]}" <"$KEY_FILE"
}

set_kh_for_env() {
  local env_flag=()
  if [[ -n "$1" ]]; then
    env_flag=(--env "$1")
  fi
  [[ -n "$KNOWN_HOSTS_FILE" ]] || return 0
  run_gh gh secret set SSH_KNOWN_HOSTS --repo "$REPO" "${env_flag[@]}" <"$KNOWN_HOSTS_FILE"
}

case "$ENV_TARGET" in
  repo)
    set_key_for_env ""
    set_kh_for_env ""
    ;;
  production|staging)
    set_key_for_env "$ENV_TARGET"
    set_kh_for_env "$ENV_TARGET"
    ;;
  all)
    set_key_for_env "production"
    set_kh_for_env "production"
    set_key_for_env "staging"
    set_kh_for_env "staging"
    ;;
  *)
    echo "--env must be production, staging, all, or repo" >&2
    exit 2
    ;;
esac

echo "Done. Secrets updated for: $ENV_TARGET (repo $REPO)" >&2
