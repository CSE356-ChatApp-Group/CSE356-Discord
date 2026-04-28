#!/usr/bin/env bash
# End-to-end: docker compose (nginx + api + prom + deps) → seed channel → sustained burst → Prometheus convoy queries.
#
# Prerequisites: Docker, ports 80 and 9090 available on localhost.
#
#   ./scripts/run-local-hot-channel-convoy-e2e.sh
#   CONCURRENCY=8 DURATION_SEC=45 ./scripts/run-local-hot-channel-convoy-e2e.sh
#
# Skip Docker (use existing API + Prom): provide TOKEN + CHANNEL_ID
#   SKIP_COMPOSE=1 BASE_URL=http://localhost/api/v1 TOKEN=... CHANNEL_ID=... ./scripts/run-local-hot-channel-convoy-e2e.sh
#
# If POST /auth/register returns iconv `../encodings` errors in Docker, fix the api volume tree:
#   docker compose exec -u root api sh -c 'cd /app && npm install iconv-lite@0.6.3 --no-audit'
#
# Outputs: /tmp/chatapp-hot-channel-bench.json and /tmp/chatapp-hot-channel-prom.json (override with OUT_PREFIX=...)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_PREFIX="${OUT_PREFIX:-/tmp/chatapp-hot-channel}"
COMPOSE="${COMPOSE:-docker compose}"
CONCURRENCY="${CONCURRENCY:-8}"
DURATION_SEC="${DURATION_SEC:-40}"
METRICS_BURST_WINDOW="${METRICS_BURST_WINDOW:-3m}"
# Do not include `migrate` by default — it shares backend_node_modules with `api` and can
# fail with ENOTEMPTY when run alongside a live api. First boot: `docker compose up -d migrate` once.
SERVICES="${HOT_CHANNEL_E2E_SERVICES:-postgres redis minio minio-init api nginx prometheus alertmanager}"
PROM_URL="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
API_BASE="${BASE_URL:-http://localhost/api/v1}"

if [[ "${SKIP_COMPOSE:-}" != "1" ]]; then
  echo "==> Starting compose stack (${SERVICES})..."
  $COMPOSE up -d $SERVICES

  echo "==> Waiting for API via nginx (http://localhost/health — app exposes /health, not under /api/v1)..."
  for i in $(seq 1 90); do
    if curl -fsS "http://localhost/health" >/dev/null 2>&1; then
      echo "API healthy."
      break
    fi
    if [[ "$i" -eq 90 ]]; then
      echo "ERROR: API did not become healthy in time." >&2
      exit 1
    fi
    sleep 2
  done

  echo "==> Waiting for Prometheus on ${PROM_URL}/-/healthy ..."
  for i in $(seq 1 40); do
    if curl -fsS "${PROM_URL}/-/healthy" >/dev/null 2>&1; then
      echo "Prometheus healthy."
      break
    fi
    if [[ "$i" -eq 40 ]]; then
      echo "WARN: Prometheus not healthy; metrics step may fail." >&2
    fi
    sleep 2
  done

  # Warm Prometheus with at least one scrape after API is up
  sleep 20
else
  echo "==> SKIP_COMPOSE=1 (using BASE_URL=${API_BASE})"
  : "${TOKEN:?set TOKEN when SKIP_COMPOSE=1}" "${CHANNEL_ID:?set CHANNEL_ID when SKIP_COMPOSE=1}"
fi

if [[ -z "${TOKEN:-}" || -z "${CHANNEL_ID:-}" ]]; then
  echo "==> Seeding user + channel..."
  SEED_FILE="${OUT_PREFIX}-seed.json"
  BASE_URL="${API_BASE}" node "$ROOT/scripts/local-api-seed-channel.mjs" >"$SEED_FILE"
  TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('${SEED_FILE}', 'utf8')).TOKEN")
  CHANNEL_ID=$(node -p "JSON.parse(require('fs').readFileSync('${SEED_FILE}', 'utf8')).CHANNEL_ID")
fi
echo "Channel: $CHANNEL_ID"

echo "==> Sustained hot-channel burst (${CONCURRENCY} workers, ${DURATION_SEC}s)..."
BASE_URL="${API_BASE}" \
  TOKEN="$TOKEN" \
  CHANNEL_ID="$CHANNEL_ID" \
  CONCURRENCY="$CONCURRENCY" \
  DURATION_SEC="$DURATION_SEC" \
  node "$ROOT/backend/scripts/bench-channel-hot-sustained.mjs" | tee "${OUT_PREFIX}-bench.json"

echo "==> Waiting 15s for Prometheus to ingest scrape after burst..."
sleep 15

echo "==> Prometheus convoy snapshot (window=${METRICS_BURST_WINDOW})..."
METRICS_BURST_WINDOW="$METRICS_BURST_WINDOW" \
  PROMETHEUS_URL="$PROM_URL" \
  bash "$ROOT/scripts/hot-channel-convoy-validate.sh" | tee "${OUT_PREFIX}-prom.json"

echo ""
echo "Done. Artifacts:"
echo "  ${OUT_PREFIX}-bench.json"
echo "  ${OUT_PREFIX}-prom.json"
echo ""
echo "Convoy heuristic (manual): low 503 + low lock timeout increase + wait p99 << 4000ms => convoy mitigated."
