#!/usr/bin/env bash
# Build and package a production deploy tarball matching CI (.github/workflows/deploy-manual.yml).
# Use with deploy-prod.sh / deploy-prod-multi.sh:
#   ./scripts/release/package-release-artifact.sh
#   LOCAL_ARTIFACT_PATH="$PWD/releases/chatapp-$(git rev-parse HEAD).tar.gz" \
#     DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh "$(git rev-parse HEAD)"
#
# Set SKIP_BUILD=1 to package only when backend/dist/.build-sha matches the
# release SHA (see scripts/release/verify-backend-dist-release-sha.sh).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"
ROOT="${CHATAPP_REPO_ROOT}"
cd "$ROOT"

SHA="${1:-$(git rev-parse HEAD)}"
mkdir -p releases
OUT="releases/chatapp-${SHA}.tar.gz"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  npm run build --workspace=backend
  npm run build --workspace=frontend
else
  echo "SKIP_BUILD=1 — verifying backend/dist/.build-sha matches ${SHA} before tarring"
fi

bash "${ROOT}/scripts/release/verify-backend-dist-release-sha.sh" "${SHA}"

# Bundle production node_modules into the tarball. deploy-prod.sh no longer runs
# `npm ci` on the VM (since 1b791e5), so the artifact must contain the deps tree.
# `npm ci --omit=dev` installs prod-only deps for all workspaces; npm hoists shared
# deps to the repo-root node_modules/ and keeps version-conflicted ones in each
# workspace's local node_modules/.
echo "Installing production dependencies (npm ci --omit=dev) so node_modules is bundled..."
npm ci --omit=dev --legacy-peer-deps

# COPYFILE_DISABLE=1 suppresses macOS AppleDouble (._*) resource-fork sidecars that
# BSD tar would otherwise embed; without it, the Linux loader can pick up files like
# node_modules/bcrypt/prebuilds/linux-x64/._bcrypt.glibc.node and fail with
# "invalid ELF header".
COPYFILE_DISABLE=1 tar --exclude=.git --exclude=.env \
  -czf "$OUT" \
  backend/dist/ \
  backend/scripts/run-migrations.cjs \
  backend/package*.json \
  backend/tsconfig.json \
  backend/node_modules/ \
  frontend/dist/ \
  frontend/package*.json \
  migrations/ \
  node_modules/ \
  package*.json \
  .env.example \
  deploy/env/prod.required.env \
  deploy/env/staging.required.env \
  deploy/apply-env-profile.py

echo "Wrote ${OUT}"
ls -lh "$OUT"

# Sidecar checksum for manual verification (e.g. after rsync/scp). deploy-prod.sh also
# compares openssl SHA256 local vs remote before tar extract.
SUM_OUT="releases/chatapp-${SHA}.tar.gz.sha256"
if command -v shasum >/dev/null 2>&1; then
  (cd releases && shasum -a 256 "chatapp-${SHA}.tar.gz" > "chatapp-${SHA}.tar.gz.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd releases && sha256sum "chatapp-${SHA}.tar.gz" > "chatapp-${SHA}.tar.gz.sha256")
else
  openssl dgst -sha256 "$OUT" | awk '{print $2}' > "${SUM_OUT}"
  echo "Wrote ${SUM_OUT} (hex only; compare: openssl dgst -sha256 \"$OUT\")"
fi
echo "Checksum sidecar: ${SUM_OUT} (on Linux VM: cd releases && sha256sum -c chatapp-${SHA}.tar.gz.sha256)"
