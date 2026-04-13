# Operations: metrics, snapshots, and triage

This document exists so operators (and the coding agent) can **ground decisions in the same metric names and queries** the app exposes. Source of truth for names is [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts).

## Quick links

| Resource | Location |
|----------|----------|
| Alert rules (PromQL) | [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) |
| Incident steps | [`RUNBOOKS.md`](RUNBOOKS.md) |
| Env tunables (search, overload, RUM) | [`env.md`](env.md), [`.env.example`](../.env.example) |
| Grafana dashboard (repo copy) | [`infrastructure/monitoring/grafana-provisioning-remote/dashboards/chatapp-overview.json`](../infrastructure/monitoring/grafana-provisioning-remote/dashboards/chatapp-overview.json) |

## Giving the agent usable telemetry

The AI cannot reach your private Prometheus from Cursor. Use one of these:

1. **Snapshot script (preferred)** — from a machine that can reach Prometheus (VM with `curl`, or laptop with an SSH tunnel):

   ```bash
   # Example: tunnel Prometheus on a host that listens on 127.0.0.1:9090
   # ssh -L 9090:127.0.0.1:9090 user@monitoring-host -N

   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics-snapshot.sh
   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics-snapshot.sh --write var/metrics-snapshot.txt
   ```

   Paste the **stdout** or the contents of `var/metrics-snapshot.txt` into the chat. The `var/` directory is gitignored.

2. **Grafana / Prometheus UI** — export panel data or run the same PromQL as in the snapshot script and paste results.

3. **`/metrics` on an app instance** — for a single process view only; use for debugging, not cluster-wide SLOs.

4. **On-VM host + pool lines (no Prometheus)** — [`scripts/prod-capacity-snapshot.sh`](../scripts/prod-capacity-snapshot.sh) curls `/health`, `diagnostic=1`, and key lines from `:4000` / `:4001` `/metrics`; run over SSH and paste the file.

## Core metric families (labels often include `job="chatapp-api"`)

| Area | Metrics | Interpretation |
|------|---------|------------------|
| HTTP | `http_server_request_duration_ms`, `http_server_requests_total` | Tail latency and volume by `route`, `method`, `status_class`. |
| Pool | `pg_pool_waiting`, `pg_pool_idle`, `pg_pool_total`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` | Queueing vs saturation vs checkout/DB errors. |
| DB / handler | `pg_queries_per_http_request` | N+1 or heavy handlers (histogram by `route`). |
| Cache | `endpoint_list_cache_total` | Redis list cache `hit` / `miss` / `coalesced` by `endpoint`. |
| Overload | `chatapp_overload_stage`, `http_overload_shed_total` | Stage 0–3; early 503s when shedding enabled. |
| Realtime | `redis_fanout_publish_failures_total`, `ws_bootstrap_wall_duration_ms`, `ws_backpressure_events_total` | Fanout health, WS bootstrap cost, slow clients. |
| Messages | `message_post_response_total`, `message_cache_bust_failures_total` | POST outcomes and cache bust issues. |
| Optional RUM | `client_web_vital_*`, `client_rum_batches_total` | Browser-side; requires `ENABLE_CLIENT_RUM` + built frontend flags. |

## Example PromQL (instant or range)

Use these in Prometheus **Graph** or in `scripts/metrics-snapshot.sh` (overlapping queries are included there).

```promql
# Pool stress
pg_pool_waiting{job="chatapp-api"}

# p95 HTTP latency by route (adjust range in UI)
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m])))

# Request rate
sum by (route) (rate(http_server_requests_total{job="chatapp-api"}[5m]))

# Overload
max(chatapp_overload_stage{job="chatapp-api"})
```

## Auth login/register stampede

Per-credential rate limits use **IP + username/email** as the Redis key. A harness that logs in as **many different synthetic users from one or a few IPs** effectively gets **one bucket per user**, so aggregate traffic can reach **hundreds of req/s** and saturate bcrypt + the event loop (Grafana: `route=/api/v1/auth/login`, `nodejs_eventloop_lag_p99` up, nginx **504**).

Optional mitigation in code: set **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`** to enable **global per-IP** limiters (`login_global_ip`, `register_global_ip`) and tunables **`AUTH_LOGIN_GLOBAL_PER_IP_*`**, **`AUTH_REGISTER_GLOBAL_PER_IP_*`** (see [`env.md`](env.md)). **Default is off** so traffic is not denied on that axis unless you opt in. **`DISABLE_RATE_LIMITS=true`** disables all auth limiters (grading-only).

## Synthetic probe (host alert)

`chatapp_synthetic_probe_success` comes from [`scripts/synthetic-probe.sh`](../scripts/synthetic-probe.sh) via node_exporter textfile — see `RUNBOOKS.md` (ChatAppSyntheticProbeFailed).
