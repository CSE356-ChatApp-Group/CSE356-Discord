#!/usr/bin/env bash
# Regression tests for deploy/lib/deploy-guards.sh (via deploy-phase-common) and release tarball SHA guards (no network, no SSH).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=deploy/lib/deploy-guards.sh
# shellcheck disable=SC1091
source "${ROOT}/deploy/lib/deploy-phase-common.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

chatapp_validate_release_sha abcdef0 || fail "7-char hex should pass"
chatapp_validate_release_sha abcdef0123456789abcdef0123456789abcdef01 || fail "40-char hex should pass"

if chatapp_validate_release_sha "not-hex" 2>/dev/null; then
  fail "non-hex should fail"
fi

if chatapp_validate_release_sha "abcdef" 2>/dev/null; then
  fail "6-char hex should fail"
fi

echo "OK deploy-guards"

bash "${ROOT}/scripts/release/verify-backend-dist-release-sha.sh" --self-test
echo "OK verify-backend-dist-release-sha"

# --- Tarball backend/dist/.build-sha guards (no network) ---
tmpd="$(mktemp -d "${TMPDIR:-/tmp}/chatapp-tarball-guard.XXXXXX")"
cleanup_tar() { rm -rf "$tmpd"; }
trap cleanup_tar EXIT

good="0123456789abcdef0123456789abcdef01234567"
bad="fedcba9876543210fedcba9876543210fedcba98"
mkdir -p "${tmpd}/tree/backend/dist"
printf '%s\n' "$good" >"${tmpd}/tree/backend/dist/.build-sha"
tar -czf "${tmpd}/good.tgz" -C "${tmpd}/tree" backend

chatapp_verify_release_tarball_build_sha "${tmpd}/good.tgz" "$good" "" || fail "40-char match without git should pass"

if chatapp_verify_release_tarball_build_sha "${tmpd}/good.tgz" "$bad" "" 2>/dev/null; then
  fail "mismatched .build-sha should fail"
fi

mkdir -p "${tmpd}/badtree/backend/dist"
echo "not-a-sha" >"${tmpd}/badtree/backend/dist/.build-sha"
tar -czf "${tmpd}/invalid_content.tgz" -C "${tmpd}/badtree" backend
if chatapp_verify_release_tarball_build_sha "${tmpd}/invalid_content.tgz" "$good" "" 2>/dev/null; then
  fail "non-hex .build-sha content should fail"
fi

mkdir -p "${tmpd}/empty/backend/dist"
echo "x" >"${tmpd}/empty/backend/dist/other"
tar -czf "${tmpd}/missing_sha.tgz" -C "${tmpd}/empty" backend
if chatapp_verify_release_tarball_build_sha "${tmpd}/missing_sha.tgz" "$good" "" 2>/dev/null; then
  fail "missing .build-sha member should fail"
fi

prefix="${good:0:12}"
chatapp_verify_release_tarball_build_sha "${tmpd}/good.tgz" "$prefix" "" || fail "7–39 hex prefix match without git should pass"

echo "OK release tarball build-sha guards"
