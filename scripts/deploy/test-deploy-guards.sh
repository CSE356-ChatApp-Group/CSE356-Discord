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

# --- Static guards on deploy-prod.sh: stale .deploy-lock-prod + worker-drift ---
DEPLOY_PROD="${ROOT}/deploy/deploy-prod.sh"
[ -r "${DEPLOY_PROD}" ] || fail "deploy-prod.sh missing"

# cleanup_on_exit must be the EXIT trap and must also cover INT/TERM/HUP so a
# CI cancel or Ctrl-C still releases the remote /opt/chatapp/.deploy-lock-prod.
grep -q '^trap cleanup_on_exit EXIT INT TERM HUP$' "${DEPLOY_PROD}" \
  || fail "deploy-prod.sh: cleanup_on_exit must be registered for EXIT INT TERM HUP"

# Regression: the previous _combined_cleanup trap silently *replaced*
# cleanup_on_exit and leaked /opt/chatapp/.deploy-lock-prod on every successful
# deploy across the entire prod fleet. Refuse to ship another script-late
# 'trap ... EXIT' that would re-introduce the bug.
later_trap_count=$(awk '
  /^trap cleanup_on_exit EXIT INT TERM HUP$/ { seen=1; next }
  seen && /^trap[[:space:]].*EXIT/ { c++ }
  END { print c+0 }
' "${DEPLOY_PROD}")
[ "${later_trap_count}" -eq 0 ] \
  || fail "deploy-prod.sh: an EXIT trap is registered AFTER cleanup_on_exit (would replace it and leak deploy lock)"

# cleanup_on_exit must (a) call release_remote_deploy_lock, (b) clean
# DOWNLOAD_PATH itself (formerly handled by the offending _combined_cleanup),
# and (c) defer to _cleanup_deploy_ssh_tmpdir so a parent orchestrator's
# shared SSH ControlPath dir is preserved.
awk '/^cleanup_on_exit\(\) \{/{flag=1} flag{print} /^\}$/ && flag{exit}' "${DEPLOY_PROD}" \
  | grep -q 'release_remote_deploy_lock' \
  || fail "deploy-prod.sh: cleanup_on_exit must call release_remote_deploy_lock"
# Static needle — must remain literal (shellcheck SC2016 expected, see below).
# shellcheck disable=SC2016
_dl_needle='rm -f "${DOWNLOAD_PATH}"'
awk '/^cleanup_on_exit\(\) \{/{flag=1} flag{print} /^\}$/ && flag{exit}' "${DEPLOY_PROD}" \
  | grep -Fq -- "${_dl_needle}" \
  || fail "deploy-prod.sh: cleanup_on_exit must remove DOWNLOAD_PATH (was previously handled only by _combined_cleanup)"
unset _dl_needle
awk '/^cleanup_on_exit\(\) \{/{flag=1} flag{print} /^\}$/ && flag{exit}' "${DEPLOY_PROD}" \
  | grep -q '_cleanup_deploy_ssh_tmpdir' \
  || fail "deploy-prod.sh: cleanup_on_exit must call _cleanup_deploy_ssh_tmpdir (honors _DEPLOY_SSH_TMPDIR_OWNED)"

# WSVM1:chatapp@4005 stale-drop-in regression: the script must refuse to
# deploy when the host runs MORE chatapp@ workers than CHATAPP_INSTANCES
# expects, otherwise the rolling restart silently misses the extras.
grep -q "systemctl list-units 'chatapp@\*\\.service' --state=active" "${DEPLOY_PROD}" \
  || fail "deploy-prod.sh: missing remote chatapp@ active-unit enumeration for drift check"
grep -q 'extra worker' "${DEPLOY_PROD}" \
  || fail "deploy-prod.sh: drift check error message must call out extra workers"
grep -q 'silently keep an old release drop-in' "${DEPLOY_PROD}" \
  || fail "deploy-prod.sh: drift check must explain WHY (stale drop-in) so operators do not just bypass"

echo "OK deploy-prod.sh trap + worker-drift guards"

# --- deploy-prod-multi.sh: fleet release parity gate ---
MULTI="${ROOT}/deploy/deploy-prod-multi.sh"
[ -r "${MULTI}" ] || fail "deploy-prod-multi.sh missing"
grep -Eq '^verify_fleet_release_parity\(\)' "${MULTI}" \
  || fail "deploy-prod-multi.sh: verify_fleet_release_parity() helper missing"
grep -Eq '^collect_vm_release_state\(\)' "${MULTI}" \
  || fail "deploy-prod-multi.sh: collect_vm_release_state() helper missing"

# Phase 7.5 must invoke the parity gate from the final-health flow.
awk '
  /=== Phase 7: Final health check/ { region=1 }
  region && /verify_fleet_release_parity / { found=1 }
  END { exit(found ? 0 : 1) }
' "${MULTI}" \
  || fail "deploy-prod-multi.sh: verify_fleet_release_parity not invoked after Phase 7 banner"

# Diagnostic content: failure message must show per-port pid, drop-in, and
# remediation guidance instead of a bare "drift detected".
grep -q 'DRIFT  :' "${MULTI}" \
  || fail "deploy-prod-multi.sh: parity diagnostics must mark drifting workers with 'DRIFT'"
grep -q 'drop=/etc/systemd/system/' "${MULTI}" \
  || fail "deploy-prod-multi.sh: parity diagnostics must surface the systemd drop-in path"
grep -q 'CHATAPP_INSTANCES in /opt/chatapp/shared/.env disagrees' "${MULTI}" \
  || fail "deploy-prod-multi.sh: parity error message must explain the canonical drift cause"

echo "OK deploy-prod-multi.sh fleet parity gate"
