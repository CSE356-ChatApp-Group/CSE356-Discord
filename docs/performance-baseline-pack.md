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

## Fan-out multiplier (30k msg/s roadmap)

Channel posts publish to **`channel:<uuid>` first**, then duplicate to each visible member’s **`user:<uuid>`** (unless `CHANNEL_MESSAGE_USER_FANOUT=0`). To compare runs:

1. Note community size in the scenario (members = Redis publishes per message, upper bound).
2. After a load test, pull Prometheus (see [`docs/operations-monitoring.md`](./operations-monitoring.md)) or run:

```bash
PROMETHEUS_URL='https://your-prometheus' ./scripts/measure-fanout-baseline.sh
```

3. Correlate `POST /api/v1/messages` latency with `presence_fanout_recipients` / Redis publish rates.

Metrics: `message_ingest_stream_appended_total` (optional Redis Stream log), `presence_fanout_recipients` histogram.
