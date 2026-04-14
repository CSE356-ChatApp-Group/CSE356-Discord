# Performance Baseline Pack

Use this pack to compare performance runs consistently before and after tuning.

## Current baseline runs (2026-04-14)

- Break envelope: `artifacts/load-tests/20260414T172409Z-break`
- SLO steady-state: `artifacts/load-tests/20260414T174514Z-slo`
- Generated baseline comparison: `artifacts/load-tests/20260414-baseline-pack.md`

## Regenerate runs

```bash
./scripts/run-staging-capacity.sh slo
./scripts/run-staging-capacity.sh break
```

## Compare any two runs

```bash
node "./scripts/compare-capacity-runs.mjs" \
  "/absolute/path/to/baseline-run-dir" \
  "/absolute/path/to/candidate-run-dir" \
  > "artifacts/load-tests/compare-$(date -u +%Y%m%dT%H%M%SZ).md"
```

## Comparison metrics to gate promotion

- Throughput: `http_reqs` average rate and completed iterations
- Failures: HTTP failed rate, status `0`, `503`, and `5xx-other`
- Tail latency: overall p95/p99 and hot-route p95s
- DB pressure: `pg_pool_waiting` peak and `http_aborted_increase_15m`
- Stability: WebSocket success rate and event-loop peak
