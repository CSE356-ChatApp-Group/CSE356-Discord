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
# `require('iconv-lite')` can succeed while `body-parser` still hits dynamic `../encodings`
# loads (missing subdir on some npm/volume trees). Ensure the full package is present.
if ! [ -d node_modules/iconv-lite/encodings ]; then
  echo "[docker-api-boot] iconv-lite encodings missing; installing full iconv-lite"
  npm install iconv-lite@0.6.3 --no-audit --no-fund
fi
sanity
exec npm run dev
