#!/usr/bin/env bash
# Wrapper: see redis-memory-soak-30m.py
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/scripts/redis-memory-soak-30m.py" "$@"
