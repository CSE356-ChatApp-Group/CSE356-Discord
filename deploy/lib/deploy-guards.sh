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

# Read backend/dist/.build-sha from a packaged release tarball (single member, fail closed).
# Prints the trimmed 40-char lowercase hex digest to stdout.
chatapp_read_tarball_build_sha() {
  local tarball="${1:?tarball path required}"
  if [[ ! -f "$tarball" ]]; then
    echo "chatapp_read_tarball_build_sha: file not found: ${tarball}" >&2
    return 1
  fi
  local entries=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "$line" =~ ^(\./)?backend/dist/\.build-sha$ ]]; then
      entries+=("$line")
    fi
  done < <(tar -tf "$tarball" 2>/dev/null || true)
  local n="${#entries[@]}"
  if [[ "$n" -eq 0 ]]; then
    echo "ERROR: tarball is missing backend/dist/.build-sha: ${tarball}" >&2
    echo "  Refuse to deploy: CI release artifacts must include backend/dist with build metadata." >&2
    return 1
  fi
  if [[ "$n" -gt 1 ]]; then
    echo "ERROR: tarball has ambiguous backend/dist/.build-sha paths (${n} matches) in: ${tarball}" >&2
    return 1
  fi
  local member="${entries[0]}"
  member="${member#./}"
  local raw
  if ! raw="$(tar -xOf "$tarball" "$member" 2>/dev/null | tr -d '[:space:]')"; then
    echo "ERROR: could not read ${member} from tarball: ${tarball}" >&2
    return 1
  fi
  if [[ ! "$raw" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: ${member} in tarball must contain a 40-character hex git object id (got '${raw}')." >&2
    return 1
  fi
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
}

# Fail closed before scp/SSH deploy: tarball bytes must match the requested release commit.
# Args: tarball_path, requested_release_sha, optional_repo_root
# - When optional_repo_root/.git exists, resolves requested_release_sha via git rev-parse (same as verify-backend-dist-release-sha.sh).
# - Otherwise: full 40-char hex must match exactly, or 7–39 char hex must be a prefix of the tarball digest.
chatapp_verify_release_tarball_build_sha() {
  local tarball="${1:?tarball path required}"
  local requested="${2:?requested release sha required}"
  local repo_root="${3:-}"

  local dist_lc
  if ! dist_lc="$(chatapp_read_tarball_build_sha "$tarball")"; then
    return 1
  fi

  local want_lc=""
  if [[ -n "$repo_root" && -d "${repo_root}/.git" ]]; then
    if ! want_lc="$(git -C "$repo_root" rev-parse "${requested}^{commit}" 2>/dev/null | tr '[:upper:]' '[:lower:]')"; then
      echo "ERROR: '${requested}' is not a valid git commit in ${repo_root}." >&2
      return 1
    fi
  else
    local req_lc
    req_lc="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')"
    if [[ "$req_lc" =~ ^[0-9a-f]{40}$ ]]; then
      want_lc="$req_lc"
    elif [[ "$req_lc" =~ ^[0-9a-f]{7,39}$ ]]; then
      if [[ "$dist_lc" != "$req_lc"* ]]; then
        echo "ERROR: tarball backend/dist/.build-sha does not match requested deploy SHA prefix." >&2
        echo "  tarball .build-sha: ${dist_lc}" >&2
        echo "  requested (prefix): ${req_lc}" >&2
        echo "  Set LOCAL_ARTIFACT_PATH to the CI/GitHub release tarball for this commit, or run from a git checkout." >&2
        return 1
      fi
      echo "✓ Tarball backend/dist/.build-sha matches requested prefix ${req_lc} (full digest ${dist_lc})"
      return 0
    else
      echo "ERROR: invalid requested release SHA: '${requested}' (need git repo or 7–40 hex)." >&2
      return 1
    fi
  fi

  if [[ "$dist_lc" != "$want_lc" ]]; then
    echo "ERROR: tarball backend/dist/.build-sha does not match requested deploy SHA (fail closed before remote copy)." >&2
    echo "  tarball .build-sha: ${dist_lc}" >&2
    echo "  requested (resolved): ${want_lc}" >&2
    echo "  artifact: ${tarball}" >&2
    echo "  Do not reuse stale releases/chatapp-*.tar.gz: use gh release download or package-release-artifact.sh for this SHA." >&2
    return 1
  fi
  echo "✓ Tarball backend/dist/.build-sha matches deploy SHA ${want_lc}"
  return 0
}
