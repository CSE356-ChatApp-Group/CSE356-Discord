#!/usr/bin/env bash
# Recommended checks after a risky deploy or before production cutover.
# See deploy/README.md (zero-downtime rollout) and docs/RUNBOOKS.md (grader watcher).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STAGING_HOST="${STAGING_HOST:-136.114.103.71}"
export API_CONTRACT_BASE_URL="${API_CONTRACT_BASE_URL:-http://${STAGING_HOST}/api/v1}"
export API_CONTRACT_WS_URL="${API_CONTRACT_WS_URL:-ws://${STAGING_HOST}/ws}"

echo "=== 1) Deploy script sanity (bash -n + python compile) ==="
bash -n deploy/preflight-check.sh deploy/deploy-staging.sh deploy/deploy-prod.sh
python3 -m py_compile deploy/apply-env-profile.py deploy/ensure-pgdump-env.py deploy/prometheus-db-file-sd.py

echo "=== 2) Backend unit tests ==="
npm run test --workspace=backend -- --runInBand

echo "=== 3) API contract vs staging (${API_CONTRACT_BASE_URL}) ==="
npm run api-contract

if [[ "${SKIP_GRADER_WATCH_GATE:-0}" == "1" ]]; then
  echo "=== 4) Grader watch gate (skipped: SKIP_GRADER_WATCH_GATE=1) ==="
else
  echo "=== 4) Grader watch gate (last ${GRADER_GATE_WINDOW_SECONDS:-900}s, set SKIP_GRADER_WATCH_GATE=1 to skip) ==="
  EVENTS_FILE="${EVENTS_FILE:-artifacts/rollout-monitoring/grader-watch-events.jsonl}"
  if [[ ! -s "${EVENTS_FILE}" ]]; then
    echo "No ${EVENTS_FILE} — skipping gate (run npm run grader:watch during soak, then re-run with REQUIRE_GRADER_WATCH_GATE=1 to enforce)."
    if [[ "${REQUIRE_GRADER_WATCH_GATE:-0}" == "1" ]]; then
      echo "ERROR: REQUIRE_GRADER_WATCH_GATE=1 but events file missing." >&2
      exit 2
    fi
  else
    ./scripts/grader-watch-gate.sh --window-seconds "${GRADER_GATE_WINDOW_SECONDS:-900}"
  fi
fi

echo "=== 5) Optional: staging SLO load (not run automatically; ~9m) ==="
echo "When ready: npm run load:staging:slo"
echo "OK — recommended-release-verify complete"
