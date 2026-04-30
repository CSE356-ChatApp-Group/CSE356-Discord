#!/usr/bin/env bash
# Wrapper: see redis-memory-soak-30m.py
set -euo pipefail
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${_SCRIPT_DIR}/redis-memory-soak-30m.py" "$@"
