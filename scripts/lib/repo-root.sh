# Source from any script under scripts/<category>/ (not from scripts/lib itself):
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"
# Sets CHATAPP_REPO_ROOT to the monorepo root.
# shellcheck shell=bash
if [[ -z "${CHATAPP_REPO_ROOT:-}" ]]; then
  _chatapp_scripts_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  CHATAPP_REPO_ROOT="$(cd "${_chatapp_scripts_lib}/../.." && pwd)"
  export CHATAPP_REPO_ROOT
  unset _chatapp_scripts_lib
fi
