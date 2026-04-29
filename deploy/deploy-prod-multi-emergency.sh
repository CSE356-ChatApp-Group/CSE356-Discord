#!/bin/bash
# Emergency multi-VM deploy wrapper.
# Uses deploy-prod-multi.sh --emergency to minimize time-to-stable during incidents.
#
# Usage:
#   bash deploy/deploy-prod-multi-emergency.sh <release-sha>
#   bash deploy/deploy-prod-multi-emergency.sh <release-sha> --rollback

set -euo pipefail

SHA=${1:?Usage: deploy-prod-multi-emergency.sh <sha> [--rollback]}
FLAG="${2:-}"
if [[ -n "${FLAG}" && "${FLAG}" != "--rollback" ]]; then
  echo "Usage: deploy-prod-multi-emergency.sh <sha> [--rollback]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Emergency deploy mode (multi-VM)"
echo "   sha: ${SHA:0:12}"
echo "   rollback: ${FLAG:-false}"
echo "   skips: DB SSH preflight, intermediate verifies, upstream re-injection checks, monitoring sync"
echo "   keeps: staged VM rollout + quick final sanity check"

args=("${SHA}" "--emergency")
if [[ -n "${FLAG}" ]]; then
  args+=("${FLAG}")
fi
bash "${SCRIPT_DIR}/deploy-prod-multi.sh" "${args[@]}"
