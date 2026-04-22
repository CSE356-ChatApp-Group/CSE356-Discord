#!/bin/bash
# deploy/prepare-rollback.sh
# Pre-stage old release on spare port for atomic rollback (just flip port in nginx).
#
# Current rollback (--rollback flag):
#   1. Artifact already on disk
#   2. Just restart worker on old port
#   3. Takes 2-3 minutes
#
# This script goes further: pre-stages old release while new one is running,
# enabling "atomic" rollback (just nginx config change) in seconds if needed.
#
# NOT YET INTEGRATED - This is a design for future enhancement.
# Current implementation would require:
#   - Parallel build of old release during new deploy
#   - Triggering on "deploy successful, moving to next VM"
#   - Background task that doesn't block main deploy

set -euo pipefail

USAGE="Usage: $0 --current <sha> --prev <sha> --target <prod-host>"

CURRENT_SHA=""
PREV_SHA=""
TARGET_HOST=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --current) CURRENT_SHA="$2"; shift 2 ;;
    --prev) PREV_SHA="$2"; shift 2 ;;
    --target) TARGET_HOST="$2"; shift 2 ;;
    *) echo "ERROR: $USAGE" >&2; exit 1 ;;
  esac
done

if [ -z "$CURRENT_SHA" ] || [ -z "$PREV_SHA" ] || [ -z "$TARGET_HOST" ]; then
  echo "ERROR: $USAGE" >&2
  exit 1
fi

echo "📦 Pre-staging rollback release..."
echo "  Current: $CURRENT_SHA"
echo "  Rollback target: $PREV_SHA"
echo "  Host: $TARGET_HOST"
echo ""

# Strategy:
# 1. Check if old release is already on disk
# 2. If not, download and build in background on old port (4000 for dual-worker)
# 3. Once ready, just need to flip nginx upstream to use old port

OLD_PORT=4000
NEW_PORT=4001

ssh ubuntu@$TARGET_HOST "
  set -euo pipefail
  RELEASE_DIR=/opt/chatapp/releases
  OLD_RELEASE=\$RELEASE_DIR/$PREV_SHA
  NEW_RELEASE=\$RELEASE_DIR/$CURRENT_SHA

  if [ -d \"\$OLD_RELEASE\" ]; then
    echo '✓ Previous release already on disk'
    du -sh \"\$OLD_RELEASE\"
    exit 0
  fi

  echo 'Downloading previous release for fast rollback...'
  cd \"\$RELEASE_DIR\"
  mkdir -p $PREV_SHA
  # Note: In production this would download from GH releases
  # For now, this is just the structure/design
  echo 'Note: Implement GitHub release download here'
" &

STAGING_PID=$!

echo "📌 Rollback pre-staging started in background (PID: $STAGING_PID)"
echo "   If deploy succeeds, this completes quietly in background"
echo "   If deploy fails, can use pre-staged release for faster rollback"
