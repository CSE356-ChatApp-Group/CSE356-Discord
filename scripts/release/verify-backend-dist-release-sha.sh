#!/usr/bin/env bash
# Fail if backend/dist/.build-sha is missing or does not match the release SHA.
# Used by package-release-artifact.sh and CI before tarring. See deploy/README.md.
#
# Usage:
#   verify-backend-dist-release-sha.sh <release-sha>
#   verify-backend-dist-release-sha.sh --self-test   # no backend/dist required
set -euo pipefail

chatapp_verify_backend_dist_matches_release() {
  local root="${1:?repo root}"
  local requested="${2:?release sha}"
  local meta="${root}/backend/dist/.build-sha"

  if [[ ! -f "$meta" ]]; then
    echo "ERROR: ${meta} is missing." >&2
    echo "  Run a full backend build (do not use SKIP_BUILD=1 until dist exists):" >&2
    echo "    npm run build --workspace=backend" >&2
    echo "  The build writes backend/dist/.build-sha from the current git HEAD." >&2
    return 1
  fi

  local dist_raw
  dist_raw="$(tr -d '[:space:]' <"$meta")"
  if [[ ! "$dist_raw" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: ${meta} must contain a 40-character hex git object id (got '${dist_raw}')." >&2
    return 1
  fi
  local dist_lc
  dist_lc="$(printf '%s' "$dist_raw" | tr '[:upper:]' '[:lower:]')"

  local want_lc
  if [[ -d "${root}/.git" ]]; then
    local want
    if ! want="$(git -C "${root}" rev-parse "${requested}^{commit}" 2>/dev/null)"; then
      echo "ERROR: '${requested}' is not a valid commit in ${root}." >&2
      return 1
    fi
    want_lc="$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')"
  else
    # Self-test temp tree (no .git): require exact full 40-char hex match.
    if [[ ! "$requested" =~ ^[0-9a-fA-F]{40}$ ]]; then
      echo "ERROR: without a git checkout, release SHA must be a full 40-character hex id." >&2
      return 1
    fi
    want_lc="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')"
  fi

  if [[ "$dist_lc" != "$want_lc" ]]; then
    echo "ERROR: backend/dist build SHA does not match the requested release SHA." >&2
    echo "  backend/dist/.build-sha: ${dist_raw}" >&2
    echo "  release (resolved):      ${want_lc}" >&2
    echo "  Rebuild without SKIP_BUILD=1 so backend/dist matches this commit, then re-package." >&2
    return 1
  fi
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/chatapp-dist-verify.XXXXXX")"
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT

  good="0123456789abcdef0123456789abcdef01234567"
  bad="fedcba9876543210fedcba9876543210fedcba98"
  mkdir -p "$tmp/backend/dist"

  printf '%s\n' "$good" >"$tmp/backend/dist/.build-sha"
  chatapp_verify_backend_dist_matches_release "$tmp" "$good" || {
    echo "FAIL: expected match for identical full SHA" >&2
    exit 1
  }

  printf '%s\n' "$bad" >"$tmp/backend/dist/.build-sha"
  if chatapp_verify_backend_dist_matches_release "$tmp" "$good" 2>/dev/null; then
    echo "FAIL: expected mismatch failure" >&2
    exit 1
  fi

  rm -f "$tmp/backend/dist/.build-sha"
  if chatapp_verify_backend_dist_matches_release "$tmp" "$good" 2>/dev/null; then
    echo "FAIL: expected missing-file failure" >&2
    exit 1
  fi

  echo "OK verify-backend-dist-release-sha (--self-test)"
  exit 0
fi

RELEASE_SHA="${1:?Usage: $0 <release-sha> | $0 --self-test}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"
chatapp_verify_backend_dist_matches_release "${CHATAPP_REPO_ROOT}" "${RELEASE_SHA}"
