#!/bin/bash
# Fast incident stabilizer for multi-VM production deploys.
# Runs deploy-prod-multi.sh in fast mode to minimize time-to-stable:
# - skips DB SSH preflight
# - skips monitoring stack sync / redis_exporter refresh
#
# Usage:
#   bash deploy/deploy-prod-multi-fast-stabilize.sh <release-sha>
#   bash deploy/deploy-prod-multi-fast-stabilize.sh <release-sha> --rollback

set -euo pipefail

SHA=${1:?Usage: deploy-prod-multi-fast-stabilize.sh <sha> [--rollback]}
FLAG="${2:-}"
if [[ -n "${FLAG}" && "${FLAG}" != "--rollback" ]]; then
  echo "Usage: deploy-prod-multi-fast-stabilize.sh <sha> [--rollback]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Fast stabilize deploy mode (multi-VM)"
echo "   sha: ${SHA:0:12}"
echo "   rollback: ${FLAG:-false}"
echo "   note: monitoring sync is skipped; run full deploy later."

args=("${SHA}" "--fast-stabilize")
if [[ -n "${FLAG}" ]]; then
  args+=("${FLAG}")
fi
bash "${SCRIPT_DIR}/deploy-prod-multi.sh" "${args[@]}"
