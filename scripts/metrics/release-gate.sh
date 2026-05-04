#!/usr/bin/env bash
# scripts/metrics/release-gate.sh
# Pass/fail release gate — exits 0 (green) or 1 (red).
# Queries Prometheus for instant health signals; thresholds match alerts.yml baselines.
#
# Usage:
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/release-gate.sh
#   PROMETHEUS_URL=http://127.0.0.1:9090 ./scripts/metrics/release-gate.sh --range 10m
#   PROMETHEUS_URL=http://127.0.0.1:9090 EXPECTED_WORKERS=16 ./scripts/metrics/release-gate.sh
#
# Exit codes:
#   0 — green  (may have warnings; nothing hard-failing)
#   1 — red    (at least one hard-fail check triggered)
#   2 — error  (could not reach Prometheus)
#
# Environment:
#   PROMETHEUS_URL          Prometheus base URL (default http://127.0.0.1:9090)
#   EXPECTED_WORKERS        Expected scrape-healthy chatapp-api workers (default 16)
#   METRICS_SNAPSHOT_RANGE  PromQL rate window (default 5m)
#   GATE_SKIP_REDIS         Set to 1 to skip Redis checks (no redis_exporter)

set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${_SCRIPT_DIR}/../lib/repo-root.sh"
source "${_SCRIPT_DIR}/../lib/promql.sh"

BASE="${PROMETHEUS_URL:-http://127.0.0.1:9090}"
BASE="${BASE%/}"
RANGE="${METRICS_SNAPSHOT_RANGE:-5m}"
EXPECTED_WORKERS="${EXPECTED_WORKERS:-16}"
SKIP_REDIS="${GATE_SKIP_REDIS:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --range) RANGE="${2:?}"; shift 2 ;;
    --workers) EXPECTED_WORKERS="${2:?}"; shift 2 ;;
    --skip-redis) SKIP_REDIS=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── helpers ────────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

prom_query() {
  local q="$1"
  local enc
  enc=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$q")
  curl -fsS --max-time 8 "${BASE}/api/v1/query?query=${enc}" 2>/dev/null || echo '{"status":"error"}'
}

# Returns the first numeric result value, or empty string if no data / error.
prom_scalar() {
  local result
  result=$(prom_query "$1")
  echo "$result" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="success": sys.exit(0)
rs=d.get("data",{}).get("result",[])
if not rs: sys.exit(0)
# take max across all result vectors
vals=[float(r["value"][1]) for r in rs if r.get("value")]
if vals: print(max(vals))
' 2>/dev/null || true
}

# Returns the sum of all result values.
prom_sum() {
  local result
  result=$(prom_query "$1")
  echo "$result" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="success": sys.exit(0)
rs=d.get("data",{}).get("result",[])
vals=[float(r["value"][1]) for r in rs if r.get("value")]
if vals: print(sum(vals))
' 2>/dev/null || true
}

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
RESULTS=()

check() {
  # check <PASS|WARN|FAIL> <label> <detail>
  local level="$1" label="$2" detail="$3"
  case "$level" in
    PASS) PASS_COUNT=$((PASS_COUNT+1)); RESULTS+=("${GREEN}  ✓ PASS${RESET}  ${label}${detail:+  ($detail)}") ;;
    WARN) WARN_COUNT=$((WARN_COUNT+1)); RESULTS+=("${YELLOW}  ⚠ WARN${RESET}  ${label}${detail:+  ($detail)}") ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT+1)); RESULTS+=("${RED}  ✗ FAIL${RESET}  ${label}${detail:+  ($detail)}") ;;
  esac
}

# ── connectivity check ─────────────────────────────────────────────────────────
if ! curl -fsS --max-time 5 "${BASE}/-/healthy" >/dev/null 2>&1; then
  echo "${RED}ERROR${RESET}: Cannot reach Prometheus at ${BASE}" >&2
  exit 2
fi

echo ""
echo "${BOLD}=== Release Gate  $(date -u +%Y-%m-%dT%H:%M:%SZ) ===${RESET}"
echo "    Prometheus : ${BASE}"
echo "    Rate window: ${RANGE}"
echo "    Workers exp: ${EXPECTED_WORKERS}"
echo ""

# ── 1. Worker availability ─────────────────────────────────────────────────────
workers_up=$(prom_sum 'sum(up{job="chatapp-api"})')
if [[ -z "$workers_up" ]]; then
  check FAIL "Workers up" "no data from Prometheus (job chatapp-api missing?)"
elif python3 -c "import sys; sys.exit(0 if float('${workers_up}') >= ${EXPECTED_WORKERS} else 1)" 2>/dev/null; then
  check PASS "Workers up" "${workers_up}/${EXPECTED_WORKERS}"
elif python3 -c "import sys; sys.exit(0 if float('${workers_up}') >= $(echo "${EXPECTED_WORKERS} * 0.75" | python3 -c 'import sys; print(int(eval(sys.stdin.read())))') else 1)" 2>/dev/null; then
  check WARN "Workers up" "${workers_up}/${EXPECTED_WORKERS} — partial fleet"
else
  check FAIL "Workers up" "${workers_up}/${EXPECTED_WORKERS} — below 75%"
fi

# ── 2. 5xx error rate ──────────────────────────────────────────────────────────
err5xx_num=$(prom_sum "sum(rate(http_server_requests_total{job=\"chatapp-api\",status_class=\"5xx\",route!=\"/metrics\"}[${RANGE}]))")
total_reqs=$(prom_sum "sum(rate(http_server_requests_total{job=\"chatapp-api\",route!=\"/metrics\"}[${RANGE}]))")
if [[ -n "$err5xx_num" && -n "$total_reqs" ]]; then
  ratio=$(python3 -c "t=float('${total_reqs}'); print(float('${err5xx_num}')/t if t>0.5 else 0)" 2>/dev/null || echo "")
  if [[ -n "$ratio" ]]; then
    pct=$(python3 -c "print(f'{float(\"${ratio}\")*100:.2f}')")
    if python3 -c "import sys; sys.exit(0 if float('${ratio}') < 0.03 else 1)" 2>/dev/null; then
      check PASS "5xx rate" "${pct}% < 3%"
    elif python3 -c "import sys; sys.exit(0 if float('${ratio}') < 0.05 else 1)" 2>/dev/null; then
      check WARN "5xx rate" "${pct}% (threshold 3%; alert at 5%)"
    else
      check FAIL "5xx rate" "${pct}% ≥ 5% — above alert threshold"
    fi
  fi
fi

# ── 3. DB pool pressure ────────────────────────────────────────────────────────
pool_waiting=$(prom_scalar 'max(pg_pool_waiting{job="chatapp-api"})')
if [[ -n "$pool_waiting" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${pool_waiting}') <= 5 else 1)" 2>/dev/null; then
    check PASS "DB pool waiting" "${pool_waiting} waiters"
  elif python3 -c "import sys; sys.exit(0 if float('${pool_waiting}') <= 15 else 1)" 2>/dev/null; then
    check WARN "DB pool waiting" "${pool_waiting} (alert at >15)"
  else
    check FAIL "DB pool waiting" "${pool_waiting} waiters — above warning threshold (>15)"
  fi
fi

# ── 4. Circuit breaker rejects ─────────────────────────────────────────────────
cb_rate=$(prom_sum "sum(rate(pg_pool_circuit_breaker_rejects_total{job=\"chatapp-api\"}[${RANGE}]))")
if [[ -n "$cb_rate" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${cb_rate}') < 0.05 else 1)" 2>/dev/null; then
    check PASS "DB circuit breaker" "$(printf '%.3f' "${cb_rate}")/s"
  elif python3 -c "import sys; sys.exit(0 if float('${cb_rate}') < 0.5 else 1)" 2>/dev/null; then
    check WARN "DB circuit breaker" "$(printf '%.3f' "${cb_rate}")/s (fail at >0.5/s)"
  else
    check FAIL "DB circuit breaker" "$(printf '%.3f' "${cb_rate}")/s ≥ 0.5/s"
  fi
fi

# ── 5. Fanout queue depth ──────────────────────────────────────────────────────
fanout_depth=$(prom_scalar 'max(side_effect_queue_depth{job="chatapp-api",queue="fanout:critical"})')
if [[ -n "$fanout_depth" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${fanout_depth}') <= 500 else 1)" 2>/dev/null; then
    check PASS "Fanout queue depth" "${fanout_depth}"
  elif python3 -c "import sys; sys.exit(0 if float('${fanout_depth}') <= 3000 else 1)" 2>/dev/null; then
    check WARN "Fanout queue depth" "${fanout_depth} (alert at >3000)"
  else
    check FAIL "Fanout queue depth" "${fanout_depth} — above 3000 alert threshold"
  fi
fi

# ── 6. Fanout queue delay p95 ──────────────────────────────────────────────────
fanout_delay=$(prom_scalar "histogram_quantile(0.95, sum by (le, queue) (rate(side_effect_queue_delay_ms_bucket{job=\"chatapp-api\",queue=\"fanout:critical\"}[${RANGE}])))")
if [[ -n "$fanout_delay" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${fanout_delay}') <= 500 else 1)" 2>/dev/null; then
    check PASS "Fanout p95 queue delay" "$(printf '%.0f' "${fanout_delay}")ms"
  elif python3 -c "import sys; sys.exit(0 if float('${fanout_delay}') <= 1500 else 1)" 2>/dev/null; then
    check WARN "Fanout p95 queue delay" "$(printf '%.0f' "${fanout_delay}")ms (alert at >1500ms)"
  else
    check FAIL "Fanout p95 queue delay" "$(printf '%.0f' "${fanout_delay}")ms ≥ 1500ms"
  fi
fi

# ── 7. Overload stage ──────────────────────────────────────────────────────────
overload=$(prom_scalar 'max(chatapp_overload_stage{job="chatapp-api"})')
if [[ -n "$overload" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${overload}') < 1 else 1)" 2>/dev/null; then
    check PASS "Overload stage" "${overload} (idle)"
  elif python3 -c "import sys; sys.exit(0 if float('${overload}') < 2 else 1)" 2>/dev/null; then
    check WARN "Overload stage" "${overload} (stage 1 — read shedding)"
  else
    check FAIL "Overload stage" "${overload} ≥ 2 — write shedding active"
  fi
fi

# ── 8. Event loop lag ──────────────────────────────────────────────────────────
evloop=$(prom_scalar 'max(nodejs_eventloop_lag_p99_seconds{job="chatapp-api"})')
if [[ -n "$evloop" ]]; then
  ms=$(python3 -c "print(f'{float(\"${evloop}\")*1000:.0f}')")
  if python3 -c "import sys; sys.exit(0 if float('${evloop}') <= 0.10 else 1)" 2>/dev/null; then
    check PASS "Event loop p99 lag" "${ms}ms"
  elif python3 -c "import sys; sys.exit(0 if float('${evloop}') <= 0.25 else 1)" 2>/dev/null; then
    check WARN "Event loop p99 lag" "${ms}ms (alert at >250ms)"
  else
    check FAIL "Event loop p99 lag" "${ms}ms ≥ 250ms"
  fi
fi

# ── 9. WS bootstrap p95 ────────────────────────────────────────────────────────
bootstrap=$(prom_scalar "histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_wall_duration_ms_bucket{job=\"chatapp-api\"}[${RANGE}])))")
if [[ -n "$bootstrap" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${bootstrap}') <= 2000 else 1)" 2>/dev/null; then
    check PASS "WS bootstrap p95" "$(printf '%.0f' "${bootstrap}")ms"
  elif python3 -c "import sys; sys.exit(0 if float('${bootstrap}') <= 5000 else 1)" 2>/dev/null; then
    check WARN "WS bootstrap p95" "$(printf '%.0f' "${bootstrap}")ms (alert at >5000ms)"
  else
    check FAIL "WS bootstrap p95" "$(printf '%.0f' "${bootstrap}")ms ≥ 5000ms"
  fi
fi

# ── 10. Delivery timeouts ──────────────────────────────────────────────────────
delivery_to=$(prom_sum "sum(rate(delivery_timeout_total{job=\"chatapp-api\"}[${RANGE}]))")
if [[ -n "$delivery_to" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${delivery_to}') < 0.05 else 1)" 2>/dev/null; then
    check PASS "Delivery timeouts" "$(printf '%.3f' "${delivery_to}")/s"
  elif python3 -c "import sys; sys.exit(0 if float('${delivery_to}') < 0.2 else 1)" 2>/dev/null; then
    check WARN "Delivery timeouts" "$(printf '%.3f' "${delivery_to}")/s"
  else
    check FAIL "Delivery timeouts" "$(printf '%.3f' "${delivery_to}")/s ≥ 0.2/s"
  fi
fi

# ── 11. WS replay fail-open ────────────────────────────────────────────────────
replay_failopen=$(prom_sum "sum(rate(ws_replay_fail_open_total{job=\"chatapp-api\",reason!=\"disabled\"}[${RANGE}]))")
if [[ -n "$replay_failopen" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${replay_failopen}') < 0.05 else 1)" 2>/dev/null; then
    check PASS "WS replay fail-open" "$(printf '%.3f' "${replay_failopen}")/s"
  elif python3 -c "import sys; sys.exit(0 if float('${replay_failopen}') < 0.2 else 1)" 2>/dev/null; then
    check WARN "WS replay fail-open" "$(printf '%.3f' "${replay_failopen}")/s (alert at >0.2/s)"
  else
    check FAIL "WS replay fail-open" "$(printf '%.3f' "${replay_failopen}")/s ≥ 0.2/s — replay safety bypassing under stress"
  fi
fi

# ── 12. DB host iowait ─────────────────────────────────────────────────────────
db_iowait=$(prom_scalar "100 * avg by (instance) (rate(node_cpu_seconds_total{job=\"db-node\",mode=\"iowait\"}[${RANGE}]))")
if [[ -n "$db_iowait" ]]; then
  if python3 -c "import sys; sys.exit(0 if float('${db_iowait}') <= 6 else 1)" 2>/dev/null; then
    check PASS "DB host iowait" "$(printf '%.1f' "${db_iowait}")%"
  elif python3 -c "import sys; sys.exit(0 if float('${db_iowait}') <= 12 else 1)" 2>/dev/null; then
    check WARN "DB host iowait" "$(printf '%.1f' "${db_iowait}")% (alert at >12%)"
  else
    check FAIL "DB host iowait" "$(printf '%.1f' "${db_iowait}")% ≥ 12% — storage bottleneck"
  fi
fi

# ── 13–14. Redis memory + evictions (optional) ─────────────────────────────────
if [[ "${SKIP_REDIS}" != "1" ]]; then
  redis_up=$(prom_scalar 'redis_up{job="redis"}')
  if [[ "$redis_up" == "1" ]]; then
    redis_used=$(prom_scalar 'redis_memory_used_bytes{job="redis"}')
    redis_max=$(prom_scalar 'redis_memory_max_bytes{job="redis"}')
    if [[ -n "$redis_used" && -n "$redis_max" ]]; then
      redis_pct=$(python3 -c "m=float('${redis_max}'); print(float('${redis_used}')/m*100 if m>0 else 0)" 2>/dev/null || echo "")
      if [[ -n "$redis_pct" ]]; then
        if python3 -c "import sys; sys.exit(0 if float('${redis_pct}') < 80 else 1)" 2>/dev/null; then
          check PASS "Redis memory" "$(printf '%.1f' "${redis_pct}")%"
        elif python3 -c "import sys; sys.exit(0 if float('${redis_pct}') < 90 else 1)" 2>/dev/null; then
          check WARN "Redis memory" "$(printf '%.1f' "${redis_pct}")% (alert at 80%)"
        else
          check FAIL "Redis memory" "$(printf '%.1f' "${redis_pct}")% ≥ 90% — eviction risk"
        fi
      fi
    fi
    redis_evict=$(prom_sum "sum(rate(redis_evicted_keys_total{job=\"redis\"}[${RANGE}]))")
    if [[ -n "$redis_evict" ]]; then
      if python3 -c "import sys; sys.exit(0 if float('${redis_evict}') == 0 else 1)" 2>/dev/null; then
        check PASS "Redis evictions" "0/s"
      else
        check WARN "Redis evictions" "$(printf '%.3f' "${redis_evict}")/s — memory pressure"
      fi
    fi
  else
    check WARN "Redis" "redis_exporter not up (skip with GATE_SKIP_REDIS=1)"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo "${BOLD}Checks:${RESET}"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo ""

VERDICT_COLOR="${GREEN}"
VERDICT="GREEN"
EXIT_CODE=0
if [[ $FAIL_COUNT -gt 0 ]]; then
  VERDICT_COLOR="${RED}"; VERDICT="RED"; EXIT_CODE=1
elif [[ $WARN_COUNT -gt 0 ]]; then
  VERDICT_COLOR="${YELLOW}"; VERDICT="YELLOW (warnings present — review before rolling to full fleet)"
fi

echo "${BOLD}${VERDICT_COLOR}Verdict: ${VERDICT}${RESET}  (${PASS_COUNT} pass / ${WARN_COUNT} warn / ${FAIL_COUNT} fail)"
echo ""
exit $EXIT_CODE
