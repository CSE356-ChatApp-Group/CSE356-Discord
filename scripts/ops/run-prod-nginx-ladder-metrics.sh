#!/usr/bin/env bash
# Poll Prometheus while SSH runs prod-vm-ladder-loadtest on VM1 (nginx BASE_URL).
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9092 VM_SSH=ubuntu@130.245.136.44 \
#   ./scripts/ops/run-prod-nginx-ladder-metrics.sh
#
# Requires: curl, python3, ssh, tee; ladder script already at VM path or set VM_SCRIPT.
#
# Controlled rerun (reduce variance between “good” and “bad” ladder windows):
#   - Pause other synthetic tests / deploys; note prod organic traffic if any.
#   - Same script + same BASE_URL / VERIFY_READ_BASE_URL / LADDER_LEVELS / SUSTAIN_SEC.
#   - Optional: warm caches (e.g. short low-concurrency phase or manual GET /messages) before main ladder.
#
# POST /messages tail attribution (logs, not Prometheus):
#   On workers (shared .env), set MESSAGE_POST_E2E_TRACE_MIN_MS=2000 for the test window, restart chatapp@,
#   then capture JSON lines with event post_messages_e2e_trace (dominant_component, channel_insert_lock_wait_ms,
#   tx_insert_ms, tx_commit_ms, fanout_wall_ms, other_unaccounted_ms). See docs/env.md and docs/operations-monitoring.md.
#
# DB statement hotness (not in this poller): from a host with DB access run scripts/postgres/pg-stat-statements-snapshot.sh
# during the same wall clock as the ladder; compare max_exec_time / mean for INSERT paths vs prior runs.
set -euo pipefail
set -o pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/repo-root.sh"

PROM="${PROMETHEUS_URL:-http://127.0.0.1:9092}"
VM_SSH="${VM_SSH:-ubuntu@130.245.136.44}"
VM_SCRIPT="${VM_SCRIPT:-/tmp/prod-vm-ladder-loadtest.mjs}"
OUT_DIR="${OUT_DIR:-var}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT_DIR}/ladder-optimistic-${TS}.txt"
VMOUT="${OUT_DIR}/ladder-optimistic-vm-${TS}.jsonl"
mkdir -p "$OUT_DIR"

pq() {
  local q="$1"
  local enc
  enc="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$q")"
  echo "--- $(date -u +%H:%M:%S)" >>"$OUT"
  echo "$q" >>"$OUT"
  curl -fsS --max-time 25 "${PROM}/api/v1/query?query=${enc}" >>"$OUT" 2>&1 || echo '{"curl":"failed"}' >>"$OUT"
  echo "" >>"$OUT"
}

poll_round() {
  pq 'sum(rate(message_channel_insert_lock_total{job="chatapp-api",result="optimistic_bypass"}[1m]))'
  pq 'histogram_quantile(0.95, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[1m])))'
  pq 'histogram_quantile(0.99, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[1m])))'
  pq 'histogram_quantile(0.95, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[1m])))'
  pq 'histogram_quantile(0.99, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[1m])))'
  pq 'histogram_quantile(0.95, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}[1m])))'
  pq 'histogram_quantile(0.99, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}[1m])))'
  pq 'sum by (vm) (rate(message_post_response_total{job="chatapp-api",status_code="503"}[1m]))'
  pq 'sum by (vm) (rate(message_post_response_total{job="chatapp-api",status_code="201"}[1m]))'
  pq 'sum(rate(message_insert_lock_wait_timeout_total{job="chatapp-api"}[1m]))'
  pq 'sum(rate(message_insert_lock_queue_reject_total{job="chatapp-api"}[1m]))'
  pq 'sum by (phase) (rate(delivery_timeout_total{job="chatapp-api"}[1m]))'
  pq 'max(pg_pool_waiting{job="chatapp-api"})'
  pq 'sum(rate(pg_pool_operation_errors_total{job="chatapp-api"}[1m])) by (reason)'
  pq 'sum(rate(pg_query_gate_rejects_total{job="chatapp-api"}[1m]))'
  pq '100 * sum(rate(node_cpu_seconds_total{job="db-node",mode="iowait"}[1m])) / clamp_min(sum(rate(node_cpu_seconds_total{job="db-node"}[1m])), 1e-9)'
  pq '100 * (1 - sum(rate(node_cpu_seconds_total{job="db-node",mode="idle"}[1m])) / clamp_min(sum(rate(node_cpu_seconds_total{job="db-node"}[1m])), 1e-9))'
  pq 'max(redis_memory_used_bytes{job="redis"})'
  pq 'sum(rate(redis_evicted_keys_total{job="redis"}[1m]))'
  pq 'max by (queue) (fanout_queue_depth{job="chatapp-api"})'
  pq 'histogram_quantile(0.99, sum by (le, path) (rate(fanout_job_latency_ms_bucket{job="chatapp-api",result="success",path="channel"}[1m])))'
}

(
  for i in $(seq 1 38); do
    echo "" >>"$OUT"
    echo "======== POLL $i $(date -u +%Y-%m-%dT%H:%M:%SZ) ========" >>"$OUT"
    poll_round
    sleep 10
  done
) &
POLLER=$!

set +e
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$VM_SSH" \
  "VERIFY_READ_BASE_URL=http://127.0.0.1:4000/api/v1 INSECURE_TLS=1 BASE_URL=https://127.0.0.1/api/v1 SUSTAIN_SEC=60 LADDER_LEVELS=5,10,20,40 VERIFY=1 node $VM_SCRIPT" 2>&1 | tee "$VMOUT"
SSH_STATUS=${PIPESTATUS[0]}
set -e

kill "$POLLER" 2>/dev/null || true
wait "$POLLER" 2>/dev/null || true

if [[ "$SSH_STATUS" -ne 0 ]]; then
  echo "ssh/node exited $SSH_STATUS" >>"$OUT"
  exit "$SSH_STATUS"
fi

if [[ -n "${METRICS_SNAPSHOT_RANGE:-}" ]] || [[ "${APPEND_METRICS_SNAPSHOT:-1}" == 1 ]]; then
  METRICS_SNAPSHOT_RANGE="${METRICS_SNAPSHOT_RANGE:-3m}" PROMETHEUS_URL="$PROM" bash "${CHATAPP_REPO_ROOT}/scripts/metrics/metrics-snapshot.sh" >>"$OUT" 2>&1 || true
fi

echo "Wrote $OUT $VMOUT"
