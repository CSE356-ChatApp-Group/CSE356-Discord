# Operations: metrics, snapshots, and triage

This document exists so operators (and the coding agent) can **ground decisions in the same metric names and queries** the app exposes. Source of truth for names is [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts).

## Quick links

| Resource | Location |
|----------|----------|
| Canary: read receipt insert-lock shedding | [`canary-read-receipt-insert-lock-shedding.md`](canary-read-receipt-insert-lock-shedding.md) |
| Alert rules (PromQL) | [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) |
| Incident steps | [`RUNBOOKS.md`](RUNBOOKS.md) |
| Env tunables (search, overload, RUM) | [`env.md`](env.md), [`.env.example`](../.env.example) |
| Grafana dashboard (repo copy) | [`infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/chatapp-overview.json`](../infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/chatapp-overview.json) |
| Instant Prometheus triage | [`scripts/metrics-snapshot.sh`](../scripts/metrics-snapshot.sh) |
| Top normalized SQL (`pg_stat_statements`) | [`scripts/pg-stat-statements-snapshot.sh`](../scripts/pg-stat-statements-snapshot.sh) |

## Where latency comes from (split app + DB VMs)

Under load, **PostgreSQL is usually the limiting factor**, not nginx or Node in isolation:

1. **Postgres / PgBouncer** — API logs show `query timeout`; metrics show **`pg_pool_waiting`** high and **`pg_pool_idle`** near zero with **`pg_pool_total`** at max; **`pg_pool_circuit_breaker_rejects_total`** and HTTP **503** “pool queue” / circuit-open errors follow. Several **`chatapp@`** workers each hold a large pool; slow statements or contention on the DB multiply waits across all processes.
2. **Redis** — publish lag affects **deferred** `POST /messages` fanout (`fanout_job_latency_ms`, `fanout_queue_depth`, `fanout_retry_total`) and WS delivery; the HTTP **201** path is decoupled. **`delivery_timeout_total`** counts only **cache-bust** wall-clock overruns (informational). PromQL SLO examples: `histogram_quantile(0.99, sum by (le,path) (rate(fanout_job_latency_ms_bucket{result="success"}[5m])))`; alerts **`ChatAppMessagePostFanoutJobLatencyP99High`** / **`ChatAppMessagePostFanoutJobLatencyP999High`** in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml).
3. **App CPU** — bcrypt login stampedes and WS fanout can spike CPU; check **`route=/api/v1/auth/login`** and event-loop lag before attributing everything to Postgres.

**MinIO:** Prometheus on the DB VM does **not** scrape MinIO health (S3 API is **127.0.0.1** on the app VM). Use **`curl -sS http://127.0.0.1:9000/minio/health/live`** on the app host or app-level errors for object storage.

## Giving the agent usable telemetry

The AI cannot reach your private Prometheus from Cursor. Use one of these:

1. **Snapshot script (preferred)** — from a machine that can reach Prometheus (VM with `curl`, or laptop with an SSH tunnel):

   ```bash
   # Example: tunnel Prometheus on a host that listens on 127.0.0.1:9090
   # ssh -L 9090:127.0.0.1:9090 user@monitoring-host -N

   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics-snapshot.sh
   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics-snapshot.sh --write var/metrics-snapshot.txt
   # 10-minute windows for stability audits (replaces embedded `[5m]` in each query):
   METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics-snapshot.sh
   ```

   Paste the **stdout** or the contents of `var/metrics-snapshot.txt` into the chat. The `var/` directory is gitignored.

   The snapshot now includes:
   - read-receipt insert-lock shed rates, insert-lock timeout/wait quantiles, POST `/messages` p95/p99 by `vm`, and related gauges
   - route p95 latency and request rate
   - p95 business-SQL round-trips per request
   - realtime fanout cache hit/miss/coalesced rates
   - realtime fanout stage/target p95 plus candidate-audience p95 before recent-connect filtering
   - deferred POST fanout: `fanout_job_latency_ms` p99, `fanout_queue_depth`, `fanout_retry_total`, `delivery_timeout_total`
   - Redis: `redis_up`, used/max memory, evictions, commands/sec (`redis_commands_processed_total` rate); SLOWLOG via `REDIS_SLOWLOG_SSH=ubuntu@<vm1> ./scripts/redis-slowlog-snapshot.sh` or embed in `PROMETHEUS_URL=... REDIS_SLOWLOG_SSH=... ./scripts/metrics-snapshot.sh`
   - websocket bootstrap wall-time, breadth, and cache-hit rate

2. **Grafana / Prometheus UI** — export panel data or run the same PromQL as in the snapshot script and paste results.

3. **`/metrics` on an app instance** — for a single process view only; use for debugging, not cluster-wide SLOs.

4. **On-VM host + pool lines (no Prometheus)** — [`scripts/prod-capacity-snapshot.sh`](../scripts/prod-capacity-snapshot.sh) curls `/health`, `diagnostic=1`, and key lines from `:4000` / `:4001` `/metrics`; run over SSH and paste the file.

5. **DB fingerprint snapshot** — when p95 moves but route-level metrics are too coarse, capture the top normalized statements from `pg_stat_statements`:

   ```bash
   DATABASE_URL='postgresql://...' ./scripts/pg-stat-statements-snapshot.sh
   DB_SSH='ubuntu@130.245.136.21' DB_NAME='chatapp_prod' ./scripts/pg-stat-statements-snapshot.sh
   PROD_DB_SSH='ubuntu@130.245.136.21' ./scripts/pg-stat-statements-snapshot.sh   # alias for DB_SSH (same as prod-pg-stat-activity.sh)

   During an incident window: `DELTA_SECONDS=120 PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/pg-stat-statements-snapshot.sh` prints **total_exec_time deltas** between two samples.
   ```

   This prints three ranked views:
   - highest total execution time
   - slowest mean execution time among frequently called statements
   - most IO-heavy statements

6. **Live slow backends (`pg_stat_activity`)** — when **5xx or p99 move without RPS moving** (per-route blocking, not pool saturation), capture what is running *right now*:

   ```bash
   PROD_DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod bash scripts/prod-pg-stat-activity.sh
   ```

   The script prints non-idle sessions ordered by **wait_event**, then the **longest `now() - query_start`** (top 15). For lock chains, see also [`scripts/sql/pg-blocking-wait-chain.sql`](../scripts/sql/pg-blocking-wait-chain.sql). `MODE=wait` or `MODE=longest` limits output to one section.

## POST `/messages` end-to-end trace (`post_messages_e2e_trace`)

Successful **`POST /api/v1/messages`** requests can emit a structured log line **`event=post_messages_e2e_trace`** when:

- **`MESSAGE_POST_E2E_TRACE_MIN_MS`** is set and wall time ≥ that value (align with Grafana p99), and/or
- **`MESSAGE_POST_E2E_TRACE_SAMPLE_RATE`** is set (e.g. **`0.01`** for ~1% sampling).

Each line includes **`requestId`**, **`worker_id`** (`hostname:PORT` from the systemd **`chatapp@`** instance), **`total_wall_ms`**, **`tx_total_ms`**, **`fanout_mode`**, **`breakdown_ms`** (idem Redis, channel insert-lock wait, per-transaction phases, hydrate, cache bust only, fanout wall, community enqueue fire-and-forget, idem success `SET`, JSON serialization, unaccounted gap), **`dominant_component`** (which single breakdown field was largest), **`dominant_bucket`** (**`db`** \| **`redis`** \| **`serialization`** \| **`hydrate_db`** \| **`other`**) for cheap rollups, and **`response_body_bytes`**.

**Correlate slow spikes**

1. **Redis** — same wall clock on the app host (or VM1 if Redis is managed): `REDIS_SLOWLOG_SSH=ubuntu@<host> ./scripts/redis-slowlog-snapshot.sh` or embed in `metrics-snapshot.sh` (see Quick links table). Compare **`channel_insert_lock_wait_ms`** and **`cache_bust_ms`** with **`SLOWLOG`** timestamps.
2. **Postgres** — `DB_SSH=ubuntu@<db-host> ./scripts/pg-stat-statements-snapshot.sh` (or **`DELTA_SECONDS`** during an incident). Match **`tx_insert_ms`** / **`tx_commit_ms`** spikes to normalized statements (insert lock, `messages` insert, attachments).
3. **Cross-worker** — filter logs by **`worker_id`** to see if one **`chatapp@`** port dominates (pool partition, hot channel serialization).

**Aggregating “% of spikes by component”** — in Loki (or any log SQL), count lines where **`dominant_bucket="db"`** vs **`redis`** vs **`serialization`** etc., divided by total **`post_messages_e2e_trace`** lines in the window. **`max()` of each numeric field in `breakdown_ms`** over the window gives worst-case per component; **`dominant_component`** answers “single biggest slice” per request (no global single cause unless one bucket dominates the rollup counts).

## POST /messages “briefly busy” **503** JSON (`code`)

The human `error` string is unchanged for clients. **`code`** distinguishes causes without reading server logs:

| `code` | Typical cause |
|--------|----------------|
| `message_post_insert_timeout` | Postgres **statement / query timeout** on insert |
| `message_insert_lock_wait_timeout` | **Redis insert lock** not acquired within wait budget (per-channel contention) |
| `message_insert_lock_recent_shed` | **Shed** after a recent lock timeout on that channel (parallel retries) |
| `message_insert_lock_waiter_cap` | **Per-channel waiter cap** exceeded |

Optional fields: **`waitedMs`**, **`lockWaiters`**. Correlate with **`requestId`** in Loki and with **`message_insert_lock_wait_timeout_total`**, **`message_channel_insert_lock_total`**, and holder/wait histograms in [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts).

## Core metric families (labels often include `job="chatapp-api"`)

| Area | Metrics | Interpretation |
|------|---------|------------------|
| HTTP | `http_server_request_duration_ms`, `http_server_requests_total` | Tail latency and volume by `route`, `method`, `status_class`. **Only responses completed by Node** increment these; **nginx-only** errors (e.g. **502** when every upstream for that try is dead, **504** upstream read timeout) may **not** appear as `status_class="5xx"` here — use **Loki** (`job=nginx` access/error logs) or `curl` timing for edge truth. |
| Pool | `pg_pool_waiting`, `pg_pool_idle`, `pg_pool_total`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` | Queueing vs saturation vs checkout/DB errors. |
| DB / handler | `pg_business_sql_queries_per_http_request`, `pg_queries_per_http_request` | Primary operator view is the business-SQL histogram by `route`; raw `pg_queries_per_http_request` also counts BEGIN/COMMIT/ROLLBACK and is mainly for engineering/debugging. |
| Cache | `endpoint_list_cache_total` | Redis list cache `hit` / `miss` / `coalesced` by `endpoint`. |
| Overload | `chatapp_overload_stage`, `http_overload_shed_total` | Stage 0–3; early 503s when shedding enabled. |
| Abuse (auto-ban) | `abuse_auto_ban_blocks_total`, `abuse_auto_ban_issued_total` | **403** from temporary Redis IP ban (`AUTO_IP_BAN_ENABLED`); bans issued after sustained rate-limit **429** strikes (external IPs only). |
| Realtime | `redis_fanout_publish_failures_total`, `fanout_publish_duration_ms`, `fanout_publish_targets`, `fanout_target_candidates`, `fanout_target_cache_total`, `conversation_fanout_targets_cache_version_retry_total`, `ws_bootstrap_wall_duration_ms`, `ws_bootstrap_channels`, `ws_bootstrap_list_cache_total`, `ws_backpressure_events_total` | Fanout health, Redis publish multiplier, candidate audience size before recent-connect filtering, target-cache effectiveness, conversation fanout cache invalidation races, WS bootstrap breadth, and slow clients. |
| Messages | `message_post_response_total`, `message_post_idempotency_poll_total`, `message_post_idempotency_poll_wait_ms`, `message_cache_bust_failures_total` | POST outcomes; idempotency duplicate-lease polls (`outcome=replay_201|exhausted_409`) and wait histogram; cache bust issues. |
| Read receipts (insert lock) | `read_receipt_shed_total{reason="message_channel_insert_lock_pressure"}`, `read_receipt_requests_total{result="deferred_message_channel_insert_lock_pressure"}`, `message_channel_insert_lock_total`, `message_channel_insert_lock_wait_ms`, `message_channel_insert_lock_pressure_wait_p95_ms`, `message_channel_insert_lock_pressure_recent_timeout_count` | Soft-defer `PUT /messages/:id/read` under per-process lock pressure; see [`canary-read-receipt-insert-lock-shedding.md`](canary-read-receipt-insert-lock-shedding.md). |
| Optional RUM | `client_web_vital_*`, `client_rum_batches_total` | Browser-side; requires `ENABLE_CLIENT_RUM` + built frontend flags. |
| Memory | `process_resident_memory_bytes{job="chatapp-api"}` | **Per Node process** (each `chatapp@` port is a target). **`ChatAppHighMemoryUsage`** in [`alerts.yml`](../infrastructure/monitoring/alerts.yml) fires when RSS **> ~650 MiB for 10m** per target — tune if VM RAM or worker count changes. Grafana overview panel overlays the same threshold. |

## Example PromQL (instant or range)

Use these in Prometheus **Graph** or in `scripts/metrics-snapshot.sh` (overlapping queries are included there).

```promql
# Workers reachable for scrape (multi-VM: expect count == configured targets, often 16)
sum(up{job="chatapp-api"})
count(up{job="chatapp-api"})

# Pool stress
pg_pool_waiting{job="chatapp-api"}

# p95 HTTP latency by route (adjust range in UI)
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[5m])))

# Request rate
sum by (route) (rate(http_server_requests_total{job="chatapp-api"}[5m]))

# Overload
max(chatapp_overload_stage{job="chatapp-api"})

# Realtime fanout stage p95
histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))

# Realtime candidate audience p95 (before recent-connect filtering / inline publish)
histogram_quantile(0.95, sum by (le, path) (rate(fanout_target_candidates_bucket{job="chatapp-api"}[5m])))

# WS bootstrap breadth p95
histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket{job="chatapp-api"}[5m])))
```

## Auth login/register stampede

Per-credential rate limits use **IP + username/email** as the Redis key. A harness that logs in as **many different synthetic users from one or a few IPs** effectively gets **one bucket per user**, so aggregate traffic can reach **hundreds of req/s** and saturate bcrypt + the event loop (Grafana: `route=/api/v1/auth/login`, `nodejs_eventloop_lag_p99` up, nginx **504**).

**Register:** **`register_global_ip`** is **always on** (tunables **`AUTH_REGISTER_GLOBAL_PER_IP_*`**) so unique-username registration floods still hit a per-IP cap. **Login:** set **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`** to enable **`login_global_ip`** and **`AUTH_LOGIN_GLOBAL_PER_IP_*`** when many distinct users share one source IP (see [`env.md`](env.md)). **`DISABLE_RATE_LIMITS=true`** disables all auth limiters (grading-only).

## Synthetic probe (host alert)

`chatapp_synthetic_probe_success` comes from [`scripts/synthetic-probe.sh`](../scripts/synthetic-probe.sh) via node_exporter textfile — see `RUNBOOKS.md` (ChatAppSyntheticProbeFailed).

## DB scaling trigger thresholds (objective gate)

Use these as a **joint condition** before resizing the DB VM. One noisy metric alone is not enough.

Scale only when all of the following persist for at least **10 minutes**:

1. `max(pg_pool_waiting{job="chatapp-api"}) >= 8`
2. Route p95 is elevated for hot write/read paths (for example `/api/v1/messages/` or `/api/v1/conversations/`) and does not recover after traffic dips
3. DB-host pressure indicators trend high together (from `db-node`):
   - iowait share materially elevated vs baseline, and
   - disk utilization (max device busy) remains high
4. Error-side corroboration appears (`http_server_requests_total{status_class="5xx"}` or `pg_pool_operation_errors_total` non-zero over window)

Do **not** scale if `pg_pool_waiting` remains near 0 and app-side lag/backpressure are the dominant signals; that pattern usually indicates app/realtime bottlenecks, not DB saturation.
