#!/bin/sh
# Used by docker-compose `api` service. Named volume node_modules can be corrupted
# (missing iconv-lite/encodings, missing esbuild for tsx). Wipe and retry before dev.
set -e
cd /app

sanity() {
  node -e "require('esbuild'); require('iconv-lite'); require('body-parser');"
}

npm ci
if ! sanity 2>/dev/null; then
  echo "[docker-api-boot] incomplete tree after npm ci; removing node_modules and retrying"
  rm -rf node_modules
  npm ci
fi
if ! sanity 2>/dev/null; then
  echo "[docker-api-boot] still failing; pinning esbuild + iconv-lite"
  npm install esbuild@^0.27.5 iconv-lite@0.4.24 --no-audit --no-fund
fi
sanity
exec npm run dev
