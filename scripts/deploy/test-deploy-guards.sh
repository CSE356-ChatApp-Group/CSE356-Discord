#!/usr/bin/env bash
# Regression tests for deploy/lib/deploy-guards.sh (no network, no SSH).
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
