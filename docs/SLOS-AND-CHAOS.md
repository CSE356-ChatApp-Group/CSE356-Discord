# SLOs, load gate, and chaos drills

## Staging load gate

- **Workflow:** [`.github/workflows/staging-load-gate.yml`](../.github/workflows/staging-load-gate.yml)
- **Script:** [`load-tests/staging-capacity.js`](../load-tests/staging-capacity.js)
- **`LOAD_PROFILE=slo`:** fixed arrival rate for steady-state checks; summary exported as `k6-slo-summary.json`.

### KPIs (optimization counters)

The k6 script defines `optimization_*` counters (login failures, message post failures, WebSocket handshake failures, HTTP outage). Weekly scheduled runs **require** repository secret `LOADTEST_PASSWORD` for staging test accounts.

### Latency and errors

- Treat **p95** HTTP latencies and **5xx ratio** from k6 output as regression signals when comparing the same profile across releases.
- Prometheus rules in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) complement this (e.g. `ChatAppHighP95Latency`, `ChatAppHigh5xxRate`, `ChatAppFast5xxBurn`).

### Documenting “good enough”

If the weekly gate is skipped (missing secrets) or profiles change, record **why** in the PR or deploy notes so the team does not assume a green load signal.

## Chaos drills (staging only)

Run **infrequently** (e.g. quarterly or before major demos), never on production without approval.

| Drill | Goal | Safe rollback |
|-------|------|----------------|
| Stop Redis briefly | Cache miss paths, WS fanout degradation | Start Redis; TTLs recover |
| Pause Postgres (read replica or brief stop) | Connection pool / 503 behavior | Restore DB |
| Restart one API instance during active WS | Reconnect + resubscribe | Nginx health checks |

After each drill: confirm **health**, **smoke E2E**, and **metrics** return to baseline within the expected window.

## Search of record

For **product** SLOs (grading / SLA), align with course docs; this file only describes how this repo encodes technical gates.
