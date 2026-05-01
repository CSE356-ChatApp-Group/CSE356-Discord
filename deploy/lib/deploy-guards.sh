# deploy/lib/deploy-guards.sh
# Shared validation helpers for deploy entrypoints (SHA format, etc.).
# shellcheck shell=bash

# Returns 0 when SHA looks like a git object id fragment (7–40 hex chars).
chatapp_validate_release_sha() {
  local sha="${1:?release sha required}"
  if [[ "${sha}" =~ ^[A-Fa-f0-9]{7,40}$ ]]; then
    return 0
  fi
  echo "ERROR: RELEASE_SHA must be a 7-40 character hexadecimal commit id (got '${sha}')." >&2
  return 1
}
