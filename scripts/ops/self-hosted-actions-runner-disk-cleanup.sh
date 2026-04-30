#!/usr/bin/env bash
# Run on a self-hosted GitHub Actions runner VM (SSH as the same user the runner uses).
# CI "out of disk space" / Chromium "Target crashed" often come from _work + browser caches.
#
# Usage (on the runner, when no workflow is executing):
#   ./scripts/ops/self-hosted-actions-runner-disk-cleanup.sh           # report only
#   RUNNER_PRUNE_CONFIRM=yes ./scripts/ops/self-hosted-actions-runner-disk-cleanup.sh
#
# Optional:
#   RUNNER_ROOT=/home/ssperrottet/actions-runner   (default: $HOME/actions-runner)
#   RUNNER_WORK_RETENTION_DAYS=2                 (default: 2) — delete *_work/*/* dirs older than N days
#   NPM_CACHE_CLEAN=1                            npm cache clean --force
#   PLAYWRIGHT_CACHE_PRUNE=1                     remove ~/.cache/ms-playwright (re-download on next e2e)
#   DOCKER_PRUNE=1                               docker system prune -af (aggressive; only if runner is Docker-only)

set -euo pipefail

RUNNER_ROOT="${RUNNER_ROOT:-${HOME}/actions-runner}"
RETAIN_DAYS="${RUNNER_WORK_RETENTION_DAYS:-2}"

echo "=== Host ==="
hostname || true
echo "=== df ==="
df -h / /dev/shm 2>/dev/null || df -h /

if [[ -d "${RUNNER_ROOT}/_work" ]]; then
  echo ""
  echo "=== Top-level under ${RUNNER_ROOT}/_work (size) ==="
  du -sh "${RUNNER_ROOT}/_work"/* 2>/dev/null | sort -h | tail -40 || true
  echo ""
  echo "=== Deepest heavy paths (sample) ==="
  du -x "${RUNNER_ROOT}/_work" 2>/dev/null | sort -n | tail -30 || true
else
  echo "No ${RUNNER_ROOT}/_work (set RUNNER_ROOT if the runner lives elsewhere)."
fi

if [[ -d "${HOME}/.cache/ms-playwright" ]]; then
  echo ""
  echo "=== Playwright browser cache ==="
  du -sh "${HOME}/.cache/ms-playwright" 2>/dev/null || true
fi

if command -v docker >/dev/null 2>&1; then
  echo ""
  echo "=== Docker disk use ==="
  docker system df 2>/dev/null || true
fi

if [[ "${RUNNER_PRUNE_CONFIRM:-}" != "yes" ]]; then
  echo ""
  echo "Report-only. To delete stale checkout trees under _work (mtime > ${RETAIN_DAYS} days), run:"
  echo "  RUNNER_PRUNE_CONFIRM=yes $0"
  exit 0
fi

if [[ ! -d "${RUNNER_ROOT}/_work" ]]; then
  echo "Refusing prune: ${RUNNER_ROOT}/_work missing"
  exit 1
fi

echo ""
echo "Pruning _work checkouts older than ${RETAIN_DAYS} days under ${RUNNER_ROOT}/_work ..."
# Layout is typically _work/<owner>/<repo>/...
deleted=0
while IFS= read -r -d '' dir; do
  echo "  rm -rf $(printf '%q' "$dir")"
  rm -rf "$dir"
  deleted=$((deleted + 1))
done < <(find "${RUNNER_ROOT}/_work" -mindepth 2 -maxdepth 2 -type d -mtime "+${RETAIN_DAYS}" -print0 2>/dev/null || true)
echo "Removed ${deleted} top-level repo work dirs (older than ${RETAIN_DAYS}d)."

if [[ "${NPM_CACHE_CLEAN:-}" == "1" ]] && command -v npm >/dev/null 2>&1; then
  echo "npm cache clean --force"
  npm cache clean --force || true
fi

if [[ "${PLAYWRIGHT_CACHE_PRUNE:-}" == "1" ]] && [[ -d "${HOME}/.cache/ms-playwright" ]]; then
  echo "Removing ${HOME}/.cache/ms-playwright"
  rm -rf "${HOME}/.cache/ms-playwright"
fi

if [[ "${DOCKER_PRUNE:-}" == "1" ]] && command -v docker >/dev/null 2>&1; then
  echo "docker system prune -af"
  docker system prune -af || true
fi

echo ""
echo "=== df after ==="
df -h / /dev/shm 2>/dev/null || df -h /
