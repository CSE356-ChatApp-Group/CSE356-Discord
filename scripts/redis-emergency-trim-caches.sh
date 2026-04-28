#!/usr/bin/env bash
# Emergency: free Redis RAM by UNLINKing cache-class keys (NOT FLUSHDB).
#
# Default pattern `stale:*` — companion payloads for distributed singleflight;
# deleting only causes cache misses until refreshed (safe, may briefly load Postgres).
#
# Usage (on a host with redis-cli + network to Redis, e.g. VM1):
#   REDIS_URL='redis://:pass@host:6379/0' ./scripts/redis-emergency-trim-caches.sh
#   REDIS_URL='...' MAX_KEYS=100000 BATCH=500 ./scripts/redis-emergency-trim-caches.sh 'stale:*'
#   DRY_RUN=1 REDIS_URL='...' ./scripts/redis-emergency-trim-caches.sh
#
# Optional patterns (more aggressive — review before use):
#   ./scripts/redis-emergency-trim-caches.sh 'channel:*:user_fanout_targets'
#   ./scripts/redis-emergency-trim-caches.sh 'community:*:members'
#
set -euo pipefail

PATTERN="${1:-stale:*}"
MAX_KEYS="${MAX_KEYS:-200000}"
BATCH="${BATCH:-500}"
DRY_RUN="${DRY_RUN:-0}"

if [[ -z "${REDIS_URL:-}" ]]; then
  echo "Set REDIS_URL (e.g. from redis_exporter REDIS_ADDR on VM1)." >&2
  exit 1
fi

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli not found" >&2
  exit 1
fi

total=0
buf=()
flush_buf() {
  if [[ "${#buf[@]}" -eq 0 ]]; then return; fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY_RUN would UNLINK %s keys\n' "${#buf[@]}"
  else
    redis-cli -u "$REDIS_URL" --no-auth-warning UNLINK "${buf[@]}" >/dev/null
  fi
  total=$((total + ${#buf[@]}))
  buf=()
}

while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  buf+=("$key")
  if [[ "${#buf[@]}" -ge "$BATCH" ]]; then
    flush_buf
  fi
  if [[ "$total" -ge "$MAX_KEYS" ]]; then
    break
  fi
done < <(redis-cli -u "$REDIS_URL" --no-auth-warning --scan --pattern "$PATTERN" 2>/dev/null || true)

flush_buf
echo "Done: pattern=$PATTERN UNLINKed_or_dry=$total (cap MAX_KEYS=$MAX_KEYS)"
