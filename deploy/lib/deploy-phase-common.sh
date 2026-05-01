# deploy/lib/deploy-phase-common.sh
# Shared entry for deploy scripts: validation helpers and future phase utilities.
# shellcheck shell=bash

_DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy-guards.sh
# shellcheck disable=SC1091
source "${_DEPLOY_LIB_DIR}/deploy-guards.sh"
