# Operations: metrics, snapshots, and triage

Status: operational
Owner: platform-operations
Last reviewed: 2026-05-01

This document exists so operators (and the coding agent) can **ground decisions in the same metric names and queries** the app exposes. Source of truth for names is [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts).

**Documentation hub** (single sources of truth, update checklist): [`README.md`](README.md).

### Canonical HTTP metric names (avoid drift)

The app registers completed HTTP traffic as **`http_server_requests_total`**, **`http_server_request_duration_ms`**, and **`http_server_requests_aborted_total`** (source: [`backend/src/utils/metrics/httpPresence.ts`](../backend/src/utils/metrics/httpPresence.ts)). **Do not** document or search for **`chatapp_http_requests_total`** or **`chatapp_http_request_duration_ms`** — those names are not exported by this codebase.

### Reuse existing metrics before new instrumentation

Confirm the question is not already answered by the series in this document and in [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts) (HTTP, pool, fanout, WS, read receipts, caches, POST traces, overload). Adding parallel counters with different names increases operator and dashboard confusion.

### Capacity triage priority (snapshots and incidents)

When ranking likely throughput limits **without** changing architecture, check in this order unless a dashboard already implicates another layer:

1. **Postgres pool saturation** — `pg_pool_waiting`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` (and route p95 on `http_server_request_duration_ms` for 503 / “pool busy” patterns).
2. **Per-channel message insert serialization** (Redis insert lock / waiters) — `message_channel_insert_lock_*`, `message_insert_lock_*`, and when enabled, **`post_messages_e2e_trace`** / insert-lock fields on **`slow_http_request_trace`**. This is usually a **higher-priority** suspect than fanout for a **single hot channel** posting fast.
3. **Realtime fanout, WS delivery, bootstrap/replay** — see [Core metric families](#core-metric-families) and [Realtime delivery miss triage](#realtime-delivery-miss-triage-grader-mean-vs-p95).

**Internal WS `subscribe_channels` / `subscribe_communities`** (see `backend/src/websocket/redisPubsubDelivery.ts`): server-issued commands that **await many `subscribeClient` calls** are used for **membership / join / DM routing** flows. They are **burst-shaped** (e.g. after a user joins), **not** a per-**`message:created`** steady-state path. Do not treat them as the default explanation for chat send rate unless traffic is dominated by joins.

## Refactor / optimization PR comparison (Prometheus)

Use this when a PR touches **hot paths** (see [`backend-hotspots.md`](backend-hotspots.md)): search, GET/POST messages, WebSocket delivery, pool, or fanout.

1. **Baseline** — on a host that can reach Prometheus, run [`scripts/metrics/metrics-snapshot.sh`](../scripts/metrics/metrics-snapshot.sh) (optional `--write var/metrics-snapshot.txt`) **before** merge/deploy of the change; keep the output for the PR.
2. **Deploy** — ship to **staging** first when behavior could affect latency or errors.
3. **Compare** — after deploy, run the snapshot again **at similar traffic** (time-of-day aware). Compare at minimum:

| Question | Series (see also [Alert families](#alert-families-operator-map)) |
|----------|-------------------------------------------------------------------|
| API tail latency worsened? | `http_server_request_duration_ms_bucket` — filter `route` for routes you touched (confirm label values with `label_values(http_server_request_duration_ms, route)`). |
| Pool pressure | `pg_pool_waiting`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` |
| Fanout / realtime | `fanout_job_latency_ms`, `fanout_queue_depth`, publish failure counters; WS delivery counters in snapshot script output |
| Overload shedding | `chatapp_overload_stage`, `http_overload_shed_total` |

4. **Interpretation** — a refactor **without** intentional throughput change should show **no sustained regression** in p95/p99 for touched routes and no increase in pool waits or fanout error counters. If intentionally tuning a knob (TTL, batch size, pool queue), document expected direction and rollback (env revert).

**Metric names:** [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts). Full triage patterns: sections below and [`runbooks.md`](runbooks.md).

## Quick links

| Resource | Location |
|----------|----------|
| Canary: read receipt insert-lock shedding | [`history/canary-read-receipt-insert-lock-shedding.md`](history/canary-read-receipt-insert-lock-shedding.md) |
| Alert rules (PromQL) | [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) |
| Incident steps | [`runbooks.md`](runbooks.md) |
| Env tunables (search, overload, RUM) | [`env.md`](env.md), [`.env.example`](../.env.example) |
| Grafana dashboards (repo JSON) | **Overview:** [`chatapp-overview.json`](../infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/chatapp-overview.json) — **Redis / cache:** [`redis-cache-store.json`](../infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/redis-cache-store.json) (`job=redis` + app-side Redis-adjacent counters). Overview top links jump to Failure modes, Latency RCA, Redis, Overload, API routes. |
| Instant Prometheus triage | [`scripts/metrics/metrics-snapshot.sh`](../scripts/metrics/metrics-snapshot.sh) |
| Redis key families (operators’ reference) | [`redis-key-map.md`](redis-key-map.md) |
| Read-route strain canary gates | [`scripts/metrics/read-receipt-strain-gates.sh`](../scripts/metrics/read-receipt-strain-gates.sh) |
| Top normalized SQL (`pg_stat_statements`: total, max, stddev, mean, IO) | [`scripts/postgres/pg-stat-statements-snapshot.sh`](../scripts/postgres/pg-stat-statements-snapshot.sh) |
| `read_states` flush SQL fingerprints (version-skew check) | [`scripts/postgres/pg-stat-read-state-flush-fingerprints.sh`](../scripts/postgres/pg-stat-read-state-flush-fingerprints.sh) |
| **Primary DB + read replica (Prometheus)** | Alert group **`chatapp-database`** in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml): `ChatAppDbPostgresExporterDown`, replication slot **`replica_155_nvme`** inactive / WAL retain size, **`ChatAppDbReplicaNodeExporterDown`**, replica **`/mnt/replica-data`** disk. Scrape targets: [`deploy/prometheus-db-file-sd.py`](../deploy/prometheus-db-file-sd.py) writes **`file_sd/db-node.json`** (primary `:9100` + replica `:9100` when **`PG_READ_REPLICA_URL`** host differs) and **`db-postgres.json`** (primary `:9187` only). Replica **`postgres_exporter`** is optional (needs its own DSN on that host). |

## Alert families (operator map)

Use this map to jump from a page/Discord alert to the right triage section quickly.

| Family | Alert names (prefix) | First metric to check | Runbook section |
|--------|-----------------------|-----------------------|-----------------|
| API availability | `ChatAppApiDown`, `ChatAppApiDownFast`, `ChatAppSomeWorkersUnreachable` | `sum(up{job="chatapp-api"})`, `count(up{job="chatapp-api"})` | [`runbooks.md`](runbooks.md#chatappapidown--chatappapidownfast) |
| API errors/latency | `ChatAppHigh5xxRate`, `ChatAppFast5xxBurn`, `ChatApp5xxAbsoluteRate`, `ChatAppHighP95Latency`, `ChatAppSevereP95Latency`, `ChatAppHighHttpAbortRate` | `http_server_requests_total`, `http_server_requests_aborted_total`, `http_server_request_duration_ms` | [`runbooks.md`](runbooks.md#chatapphigh5xxrate--chatappfast5xxburn) |
| Pool/DB pressure | `ChatAppPgPool*`, `ChatAppPgQueryGateRejects`, `ChatAppPgPoolOperationErrors`, `ChatAppHighDbQueriesPerRequest` | `pg_pool_waiting`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` | [`runbooks.md`](runbooks.md#chatapppgpoolpressure-family) |
| Overload/shedding | `ChatAppOverloadSheddingActive`, `ChatAppOverloadSheddingCritical`, `ChatAppHttpOverloadShedding` | `chatapp_overload_stage`, `http_overload_shed_total` | [`runbooks.md`](runbooks.md#chatappoverloadsheddingactive--chatappoverloadsheddingcritical) |
| Host/resource pressure | `ChatAppHost*`, `ChatAppCpuSaturationHigh`, `ChatAppDiskSpaceLow`, `ChatAppDbDiskSpace*` | node exporter CPU/memory/iowait/filesystem series | [`runbooks.md`](runbooks.md#chatapphostpressure-family) |
| DB observability/replication | `ChatAppDbPostgresExporterDown`, `ChatAppDbReplication*`, `ChatAppDbReplica*` | `up{job="db-postgres"}`, replication slot metrics, replica disk series | [`runbooks.md`](runbooks.md#chatappdbpostgresexporterdown) |
| Realtime/delivery | `ChatAppCriticalFanout*`, `ChatAppMessagePostFanout*`, `ChatAppRealtimeFanoutSlow`, `ChatAppDeliveryFails*`, `ChatAppWs*` | `fanout_queue_depth`, `fanout_job_latency_ms`, `ws_reliable_delivery_total`, publish failure counters | [`runbooks.md`](runbooks.md#chatapprealtimedeliveryfailures-family) |
| Redis | `ChatAppRedis*` | `redis_up`, `redis_memory_used_bytes`, `redis_evicted_keys_total`, `redis_rejected_connections_total` | [`runbooks.md`](runbooks.md#chatappredis-health-family) |

## Redis list-cache tuning (evidence before TTL changes)

Use this when evaluating **message list** or **channels list** cache TTL changes (`MESSAGES_CACHE_TTL_SECS` in [`backend/src/messages/lib/messageListCache.ts`](../backend/src/messages/lib/messageListCache.ts); `CHANNELS_LIST_CACHE_TTL_SECS` via env in [`backend/src/channels/channelRouterShared.ts`](../backend/src/channels/channelRouterShared.ts) — see [`env.md`](env.md)). Ground decisions in snapshots from [`scripts/metrics/metrics-snapshot.sh`](../scripts/metrics/metrics-snapshot.sh), not invented ratios.

### Metrics to compare

| Question | Series (labels) |
|----------|-------------------|
| List endpoints hitting Redis vs loading DB | `endpoint_list_cache_total{endpoint=~"channels|messages_channel|messages_conversation|communities|conversations",result=~"hit|miss|coalesced"}` |
| Message list Redis write skipped (epoch bumped during load) | `message_list_cache_store_skipped_total` |
| Cache busts from writes / membership | `endpoint_list_cache_invalidations_total` |
| GET /messages channel access shortcut | `messages_list_access_cache_hit_total` |
| Postgres round-trips on heavy reads | `pg_queries_per_http_request_bucket`, `pg_business_sql_queries_per_http_request_bucket` (filter `route="/api/v1/messages"` or your canonical route label) |
| HTTP latency | `http_server_request_duration_ms_bucket` — confirm **`route`** label values with `label_values(http_server_request_duration_ms, route)` on your Prometheus |

### Example PromQL

Hit ratio for community channel list (adjust `job` to match your scrape):

```promql
sum(rate(endpoint_list_cache_total{job="chatapp-api",endpoint="channels",result="hit"}[5m]))
/
sum(rate(endpoint_list_cache_total{job="chatapp-api",endpoint="channels"}[5m]))
```

GET route p95 — substitute `route` after inspecting labels:

```promql
histogram_quantile(0.95,
  sum by (le, route) (
    rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="GET"}[5m])
  )
)
```

**Interpretation:** raising TTL only makes sense if **hit ratio** or **primary DB load** warrants it and **p95/p99 latency**, **`endpoint_list_cache_invalidations_total`**, and **`pg_pool_waiting`** do not worsen. Dashboard: [`redis-cache-store.json`](../infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/redis-cache-store.json).

Canonical key patterns: [`redis-key-map.md`](redis-key-map.md).

## Where latency comes from (split app + DB VMs)

Under load, **PostgreSQL is usually the limiting factor**, not nginx or Node in isolation:

1. **Postgres / PgBouncer** — API logs show `query timeout`; metrics show **`pg_pool_waiting`** high and **`pg_pool_idle`** near zero with **`pg_pool_total`** at max; **`pg_pool_circuit_breaker_rejects_total`** and HTTP **503** “pool queue” / circuit-open errors follow. Several **`chatapp@`** workers each hold a large pool; slow statements or contention on the DB multiply waits across all processes.
2. **Redis** — publish lag affects **deferred** `POST /messages` fanout (`fanout_job_latency_ms`, `fanout_queue_depth`, `fanout_retry_total`) and WS delivery; the HTTP **201** path is decoupled. **`delivery_timeout_total`** counts only **cache-bust** wall-clock overruns (informational). PromQL SLO examples: `histogram_quantile(0.99, sum by (le,path) (rate(fanout_job_latency_ms_bucket{result="success"}[5m])))`; alerts **`ChatAppMessagePostFanoutJobLatencyP99High`** / **`ChatAppMessagePostFanoutJobLatencyP999High`** in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml).
3. **App CPU** — bcrypt login stampedes and WS fanout can spike CPU; check **`route=/api/v1/auth/login`** and event-loop lag before attributing everything to Postgres.

### Focused stabilization plan (2026-05)

Current evidence from production snapshots + Loki e2e traces:
- **POST `/api/v1/messages/`**: route p95 remains elevated under load, and `post_messages_e2e_trace` is dominated by `dominant_component=fanout_wall_ms` / `dominant_bucket=redis` (multi-second tail, occasional >20s outliers).
- **Search tail**: `GET /api/v1/search/` shows low RPS but high p95 tail and higher DB-queries-per-request p95.
- **Read-state fingerprints**: modern queryid dominates by calls, but legacy `INSERT INTO read_states` shapes remain visible in cumulative `pg_stat_statements`.

Measured rollout plan (use a VM3-only canary first):
1. **Enable async POST fanout path in prod config** (`MESSAGE_POST_SYNC_FANOUT=false`).
2. Soak 15-30 minutes, then compare canary vs control with:
   - `histogram_quantile(0.95, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[5m])))`
   - `sum by (vm, result) (rate(message_post_fanout_async_enqueue_total{job="chatapp-api"}[5m]))`
   - `histogram_quantile(0.99, sum by (le, path) (rate(fanout_job_latency_ms_bucket{job="chatapp-api",result="success"}[5m])))`
   - `sum(increase(redis_fanout_publish_failures_total{job="chatapp-api"}[15m]))`
3. Pass criteria:
   - POST `/messages/` p95 improves by >=30% on canary VM.
   - `message_post_fanout_async_enqueue_total{result="queued"}` rises; `result="sync"` drops toward zero.
   - No meaningful increase in replay/fallback distress: `fanout_job_latency_ms` p99 and dead-letter/redis publish failures stay within baseline envelope.

Read-state drift verification (same canary window):
- Capture before/after with `./scripts/postgres/pg-stat-read-state-flush-fingerprints.sh`.
- Expect near-zero **new** calls on legacy read-state queryids; modern queryid should carry almost all delta calls.

**Read-state SQL:** the canonical batch upsert is defined only in [`backend/src/messages/readState/batchReadState.ts`](../backend/src/messages/readState/batchReadState.ts). Cumulative `pg_stat_statements` may still list older shapes until stats reset or those queryids age out.

#### Last-message Redis overlay vs Postgres (`channels.last_message_*`)

`POST /messages` does **not** run `UPDATE channels` inline; it enqueues Redis metadata and optionally mirrors to Postgres when **`LAST_MESSAGE_PG_RECONCILE_ENABLED`** / **`CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED`** are **`true`**. Git-tracked profiles pin **`false`** in [`deploy/env/prod.required.env`](../deploy/env/prod.required.env) and [`deploy/env/staging.required.env`](../deploy/env/staging.required.env) so periodic PG flush stays off unless you change the profile.

Correlate env with metrics (also emitted by [`scripts/metrics/metrics-snapshot.sh`](../scripts/metrics/metrics-snapshot.sh)):

- **`channel_last_message_update_deferred_total`** — Redis writes from POST (nonzero under load even when PG reconcile is off).
- **`channel_last_message_update_flushed_total`** / **`last_message_pg_reconcile_total`** — DB commits from background flush / repoint; should stay ~**0** rate when reconcile is **`false`** and **`last_message_pg_reconcile_skipped_total{reason="channel_disabled"}`** (or `conversation_disabled`) accounts for skips.

**MinIO:** Prometheus on the DB VM does **not** scrape MinIO health (S3 API is **127.0.0.1** on the app VM). Use **`curl -sS http://127.0.0.1:9000/minio/health/live`** on the app host or app-level errors for object storage.

## Giving the agent usable telemetry

The AI cannot reach your private Prometheus from Cursor. Use one of these:

1. **Snapshot script (preferred)** — from a machine that can reach Prometheus (VM with `curl`, or laptop with an SSH tunnel):

   ```bash
   # Example: tunnel Prometheus on a host that listens on 127.0.0.1:9090
   # ssh -L 9090:127.0.0.1:9090 user@monitoring-host -N
   #
   # If bind fails ("Address already in use"), another process owns that local port—often a
   # dev Prometheus or an old tunnel. Pick a free local port and match PROMETHEUS_URL:
   #   ssh -L 29090:127.0.0.1:9090 user@monitoring-host -N
   #   curl -sS 'http://127.0.0.1:29090/api/v1/status/config' | head   # sanity: expect prod scrape config
   # Wrong tunnel → queries hit local/other Prometheus (misleading series).

   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics/metrics-snapshot.sh
   PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics/metrics-snapshot.sh --write var/metrics-snapshot.txt
   # 10-minute windows for stability audits (replaces embedded `[5m]` in each query):
   METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics/metrics-snapshot.sh
   ```

   Paste the **stdout** or the contents of `var/metrics-snapshot.txt` into the chat. The `var/` directory is gitignored.

   The snapshot now includes:
   - read-receipt insert-lock shed rates, insert-lock timeout/wait quantiles, POST `/messages` p95/p99 by `vm`, and related gauges
   - route p95 latency and request rate
   - p95 business-SQL round-trips per request
   - realtime fanout cache hit/miss/coalesced rates
   - realtime fanout stage/target p95 plus candidate-audience p95 before recent-connect filtering
   - deferred POST fanout: `fanout_job_latency_ms` p99, `fanout_queue_depth`, `fanout_retry_total`, `delivery_timeout_total`
   - Redis: `redis_up`, used/max memory, evictions, commands/sec (`redis_commands_processed_total` rate); SLOWLOG via `REDIS_SLOWLOG_SSH=ubuntu@<vm1> ./scripts/redis/redis-slowlog-snapshot.sh` or embed in `PROMETHEUS_URL=... REDIS_SLOWLOG_SSH=... ./scripts/metrics/metrics-snapshot.sh`
   - websocket bootstrap wall-time, breadth, and cache-hit rate
   - websocket reliable delivery mix (`ws_reliable_delivery_total` replay %, `ws_reliable_delivery_latency_ms` p95 by path) plus reconnect rate for correlation
   - channel message user-topic fanout split (`channel_message_fanout_recipient_total`) and miss hints (`realtime_miss_attribution_total`)

2. **Grafana / Prometheus UI** — export panel data or run the same PromQL as in the snapshot script and paste results.

3. **`/metrics` on an app instance** — for a single process view only; use for debugging, not cluster-wide SLOs.

4. **On-VM host + pool lines (no Prometheus)** — [`scripts/ops/prod-capacity-snapshot.sh`](../scripts/ops/prod-capacity-snapshot.sh) curls `/health`, `diagnostic=1`, and key lines from `:4000` / `:4001` `/metrics`; run over SSH and paste the file.

5. **DB fingerprint snapshot** — when p95 moves but route-level metrics are too coarse, capture the top normalized statements from `pg_stat_statements`:

   ```bash
   DATABASE_URL='postgresql://...' ./scripts/postgres/pg-stat-statements-snapshot.sh
   DB_SSH='ubuntu@130.245.136.21' DB_NAME='chatapp_prod' ./scripts/postgres/pg-stat-statements-snapshot.sh
   PROD_DB_SSH='ubuntu@130.245.136.21' ./scripts/postgres/pg-stat-statements-snapshot.sh   # alias for DB_SSH (same as prod-pg-stat-activity.sh)

   During an incident window: `DELTA_SECONDS=120 PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/postgres/pg-stat-statements-snapshot.sh` prints **total_exec_time deltas** between two samples.
   ```

   This prints three ranked views:
   - highest total execution time
   - slowest mean execution time among frequently called statements
   - most IO-heavy statements

6. **Live slow backends (`pg_stat_activity`)** — when **5xx or p99 move without RPS moving** (per-route blocking, not pool saturation), capture what is running *right now*:

   ```bash
   PROD_DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod bash scripts/postgres/prod-pg-stat-activity.sh
   ```

   The script prints non-idle sessions ordered by **wait_event**, then the **longest `now() - query_start`** (top 15). For lock chains, see also [`scripts/postgres/sql/pg-blocking-wait-chain.sql`](../scripts/postgres/sql/pg-blocking-wait-chain.sql). `MODE=wait` or `MODE=longest` limits output to one section.

### `read_states` batch flush: SQL fingerprint drift

The background Redis → Postgres flush uses **`READ_STATE_BATCH_UPSERT_SQL`** in [`backend/src/messages/readState/batchReadState.ts`](../backend/src/messages/readState/batchReadState.ts). If **`pg_stat_statements`** shows **multiple** `INSERT INTO read_states …` rows with material **`calls`**, that usually means **mixed app builds across workers** (multi-VM deploy not fully rolled) and/or **cumulative stats** since **`stats_reset`** still counting retired query text. Tail latency (**high `stddev_exec_time` / `max_exec_time`**) on the **heaviest** variant then affects only the **fraction of traffic** hitting workers still running that SQL until the fleet is uniform.

**How significant:** aligning the fleet is **high leverage when skew exists** (removes multi-second outliers for unlucky requests); it is **neutral** if every worker already runs the same SHA. It does **not** replace contention work on **`UPDATE channels`** or hot **`read_states`** rows—that needs separate tuning.

**After a read-state / deploy change:** run a fingerprint check (cheap read on the DB):

```bash
PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/postgres/pg-stat-read-state-flush-fingerprints.sh
```

Expect **one dominant row** over time. **`SELECT pg_stat_statements_reset()`** clears all fingerprints (coordinate with ops; you lose cumulative history). Safer: roll the full fleet to one build and re-check **`calls`** growth on a single `queryid` over 24h.

### Read-route strain canary gates

When tuning `PUT /messages/:id/read` shed thresholds or hot-path costs, compare canary VM(s) vs baseline:

```bash
PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics/read-receipt-strain-gates.sh
METRICS_SNAPSHOT_RANGE=10m PROMETHEUS_URL='http://127.0.0.1:9090' ./scripts/metrics/read-receipt-strain-gates.sh
```

Primary gate metrics:
- `read_receipt_shed_total`, `read_receipt_requests_total`, `read_receipt_preflight_total`
- `read_receipt_phase_duration_ms{phase=~"target_lookup|cursor_advance|watermark_cache|fanout_publish"}`
- **`read_states` batch flush (redis → Postgres WAL):** `read_state_dirty_keys` (Redis `rs:dirty` backlog when flush runs), `read_state_flush_duration_ms`, `read_state_flush_rows`, `read_state_flush_errors_total{stage=...}`, `read_state_flush_retries_total` — PromQL examples in [`scripts/metrics/metrics-snapshot.sh`](../scripts/metrics/metrics-snapshot.sh) header comment. Series populate only after workers run at least one flush (histogram buckets appear on first observe); idle deployments may show no `_bucket` lines until traffic generates dirty keys.
- read-route p95/p99: `http_server_request_duration_ms{method="PUT",route="/api/v1/messages/:id/read"}`
- pool safety: `pg_pool_waiting`, `pg_pool_circuit_breaker_rejects_total`
- write-path guardrail: `message_post_response_total` (201 vs 503/5xx)

## POST `/messages` end-to-end trace (`post_messages_e2e_trace`)

Successful **`POST /api/v1/messages`** requests can emit a structured log line **`event=post_messages_e2e_trace`** when:

- **`MESSAGE_POST_E2E_TRACE_MIN_MS`** is set and wall time ≥ that value (align with Grafana p99), and/or
- **`MESSAGE_POST_E2E_TRACE_SAMPLE_RATE`** is set (e.g. **`0.01`** for ~1% sampling).

Each line includes **`requestId`**, **`worker_id`** (`hostname:PORT` from the systemd **`chatapp@`** instance), **`total_wall_ms`**, **`tx_total_ms`**, **`fanout_mode`**, **`breakdown_ms`** (idem Redis, channel insert-lock wait, per-transaction phases, hydrate, cache bust only, fanout wall, community enqueue fire-and-forget, idem success `SET`, JSON serialization, unaccounted gap), **`dominant_component`** (which single breakdown field was largest), **`dominant_bucket`** (**`db`** \| **`redis`** \| **`serialization`** \| **`hydrate_db`** \| **`other`**) for cheap rollups, and **`response_body_bytes`**.

**Correlate slow spikes**

1. **Redis** — same wall clock on the app host (or VM1 if Redis is managed): `REDIS_SLOWLOG_SSH=ubuntu@<host> ./scripts/redis/redis-slowlog-snapshot.sh` or embed in `metrics-snapshot.sh` (see Quick links table). Compare **`channel_insert_lock_wait_ms`** and **`cache_bust_ms`** with **`SLOWLOG`** timestamps.
2. **Postgres** — `DB_SSH=ubuntu@<db-host> ./scripts/postgres/pg-stat-statements-snapshot.sh` (or **`DELTA_SECONDS`** during an incident). Match **`tx_insert_ms`** / **`tx_commit_ms`** spikes to normalized statements (insert lock, `messages` insert, attachments).
3. **Cross-worker** — filter logs by **`worker_id`** to see if one **`chatapp@`** port dominates (pool partition, hot channel serialization).

**Aggregating “% of spikes by component”** — in Loki (or any log SQL), count lines where **`dominant_bucket="db"`** vs **`redis`** vs **`serialization`** etc., divided by total **`post_messages_e2e_trace`** lines in the window. **`max()` of each numeric field in `breakdown_ms`** over the window gives worst-case per component; **`dominant_component`** answers “single biggest slice” per request (no global single cause unless one bucket dominates the rollup counts).

## Slow non-`POST /messages` HTTP trace (`slow_http_request_trace`)

When **`SLOW_HTTP_TRACE_MIN_MS`** is set (for example **`2000`**), successful and errored requests that exceed that wall time emit **`event=slow_http_request_trace`** unless the route matches **`SLOW_HTTP_TRACE_EXCLUDE_PREFIXES`** (default excludes **`/api/v1/messages`**, **`/health`**, **`/metrics`**). For targeted canaries, set **`SLOW_HTTP_TRACE_INCLUDE_ROUTES`** (comma-separated exact route/raw path values such as **`/api/v1/messages/:id/read`**) to bypass excludes only for those routes. Each line includes **`route`**, **`requestId`**, **`worker_id`**, **`total_wall_ms`**, **`db_query_count`**, **`db_business_sql_count`**, **`db_sum_ms`** (sum of round-trip times for every `query()` / wrapped `client.query()`), **`db_max_single_ms`**, **`db_query_samples`** (up to 30 truncated statements with **`pool`** `primary` or `read`), and **`app_wall_ms_estimated`** when DB work was roughly sequential (**`db_wall_parallel_overlap_hint`** when summed DB time exceeds total wall — overlapping `await` / `Promise.all`).

**Rank slow routes by impact** — in logs or Grafana: **`sum by (route) (count)`** or request volume × p95 from Prometheus **`http_server_request_duration_ms`** for the same window; join with **`slow_http_request_trace`** counts on **`route`**.

## Slow route EXPLAIN workflow {#slow-route-explain-workflow}

1. Capture **`slow_http_request_trace`** (or **`pg: slow query`** lines from **`PG_SLOW_QUERY_MS`**) for the window; note **`db_query_samples`** and **`queryid`** from [`scripts/postgres/pg-stat-statements-snapshot.sh`](../scripts/postgres/pg-stat-statements-snapshot.sh) (`DB_SSH` / **`DATABASE_URL`**). The snapshot includes **top `total_exec_time`**, **top `max_exec_time`**, **top `stddev_exec_time`** (calls ≥ **`MIN_CALLS_STDDEV`**, default 10), slowest **mean** among frequent callers, and **IO-heavy** statements.
2. On the DB, ensure **`pg_stat_statements`** is available (`shared_preload_libraries` + **`CREATE EXTENSION`** as appropriate for your host).
3. Take the normalized SQL (from **`pg_stat_statements.query`** or app sample), bind realistic parameters, then run:
   ```sql
   SET track_io_timing = ON;
   EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <statement>;
   ```
4. Interpret: **sequential scans** on large tables → index / rewrite; **estimated rows « actual** → **`ANALYZE`** / stats; **buffers: shared read** high → cache/IO; **Lock** rows → contention; **`db_query_count`** on one HTTP request ≫ 1 with similar SQL shapes → **N+1** in handler code.
5. **Expected latency after fix** — index or plan fix often improves the dominated step by **10×–100×** until the next bottleneck; confirm with **`EXPLAIN ANALYZE`** and a canary before assuming global p99 movement.

## POST /messages “briefly busy” **503** JSON (`code`)

The human `error` string is unchanged for clients. **`code`** distinguishes causes without reading server logs:

| `code` | Typical cause |
|--------|----------------|
| `message_post_insert_timeout` | Postgres **statement / query timeout** on insert |
| `message_insert_lock_wait_timeout` | **Redis insert lock** not acquired within wait budget (per-channel contention) |
| `message_insert_lock_recent_shed` | **Shed** after a recent lock timeout on that channel (parallel retries) |
| `message_insert_lock_waiter_cap` | **Per-channel waiter cap** exceeded |

Optional fields: **`waitedMs`**, **`lockWaiters`**. Correlate with **`requestId`** in Loki and with **`message_insert_lock_wait_timeout_total`**, **`message_channel_insert_lock_total`**, and holder/wait histograms in [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts).

**Insert path (channel posts):** `message_channel_insert_path_total{path,reason_detail}` counts each decision (`optimistic_bypass`, `acquired_immediate`, `acquired_after_wait`, `redis_fallback_null_lease`) with **`reason_detail`** explaining bypass (`env_optimistic`, `env_mode_off`, `env_lock_disabled`) or serialized fallback (`none`, `redis_set_error`). `message_channel_insert_path_precall_ms_bucket` is precall queue+Redis spin by **`path`** (0 for bypass). Structured logs: **`message_channel_insert_path`** when `MESSAGE_INSERT_LOCK_PATH_LOG` or `MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE` is set (`docs/env.md`). Sampled **`post_messages_e2e_trace`** includes **`channel_insert_lock_path`** and **`channel_insert_lock_reason_detail`** when present.

## Core metric families (labels often include `job="chatapp-api"`) {#core-metric-families}

| Area | Metrics | Interpretation |
|------|---------|------------------|
| HTTP | `http_server_request_duration_ms`, `http_server_requests_total`, `http_server_requests_aborted_total` | Tail latency and volume by `route`, `method`, `status_class`. `http_server_requests_total` counts completed responses; `http_server_requests_aborted_total` captures client disconnect/abort before finish (use both for observed app load). **nginx-only** errors (e.g. **502** when every upstream for that try is dead, **504** upstream read timeout) may **not** appear as `status_class="5xx"` here — use **Loki** (`job=nginx` access/error logs) or `curl` timing for edge truth. |
| Pool | `pg_pool_waiting`, `pg_pool_idle`, `pg_pool_total`, `pg_pool_circuit_breaker_rejects_total`, `pg_pool_operation_errors_total` | Queueing vs saturation vs checkout/DB errors. |
| DB / handler | `pg_business_sql_queries_per_http_request`, `pg_queries_per_http_request` | Primary operator view is the business-SQL histogram by `route`; raw `pg_queries_per_http_request` also counts BEGIN/COMMIT/ROLLBACK and is mainly for engineering/debugging. |
| Cache | `endpoint_list_cache_total`, `endpoint_list_cache_bypass_total`, `endpoint_list_cache_invalidations_total`, `message_list_cache_store_skipped_total` | Redis list cache `hit` / `miss` / `coalesced` by `endpoint`; bypass reasons (`pagination`, `pressure`, …); invalidations on writes. **`message_list_cache_store_skipped_total{scope,reason="epoch_changed"}`** counts first-page **`GET /messages`** loads that skipped a Redis write because the cache epoch advanced during the query (concurrent POST); high rates imply hot channels rarely retain a warm JSON cache. |
| Overload | `chatapp_overload_stage`, `http_overload_shed_total` | Stage 0–3; early 503s when shedding enabled. |
| Abuse (auto-ban) | `abuse_auto_ban_blocks_total`, `abuse_auto_ban_issued_total` | **403** from temporary Redis IP ban (`AUTO_IP_BAN_ENABLED`); bans issued after sustained rate-limit **429** strikes (external IPs only). |
| Realtime | `redis_fanout_publish_failures_total`, `fanout_publish_duration_ms`, `fanout_publish_targets`, `fanout_target_candidates`, `ws_active_subscriber_targets_bucket`, `ws_fanout_offline_skipped_total`, `redis_exists_by_path_total`, `ws_recipient_duplicate_candidates_total`, `fanout_target_cache_total`, `conversation_fanout_targets_cache_version_retry_total`, `ws_bootstrap_wall_duration_ms`, `ws_bootstrap_channels`, `ws_bootstrap_list_cache_total`, `ws_backpressure_events_total`, `ws_reliable_delivery_total`, `ws_reliable_delivery_latency_ms`, `channel_message_fanout_recipient_total`, `realtime_miss_attribution_total`, `pending_replay_recipient_total`, `pending_replay_entries_per_message`, `offline_pending_skipped_total`, `ws_pending_user_zset_size`, `redis_lua_script_load_total`, `redis_lua_eval_total`, `redis_lua_noscript_retry_total` | Fanout health, Redis publish multiplier, active subscriber targets, offline skips before realtime work, Redis `EXISTS` probe rate, duplicate candidates after cross-path dedupe, target-cache effectiveness, conversation fanout cache invalidation races, WS bootstrap breadth, slow clients, and Redis Lua cache churn. **`ws_reliable_delivery_total{path,source}`** counts each reliable event actually **`ws.send`** after dedupe: **`path=realtime`** (`source=live_pubsub`) vs **`path=replay`** (`source=missed_db` reconnect SQL backfill vs `pending_queue` Redis pending drain). **`ws_reliable_delivery_latency_ms`** is ms from **`created_at` / `publishedAt`** to send (same path label). **`channel_message_fanout_recipient_total{segment}`** splits channel **`message:created`** user-topic work: **`candidate`**, **`inline_user_topic`**, **`deferred_user_topic`** (deferred = not in recent-connect inline set when HTTP blocking is off). **`realtime_miss_attribution_total{reason}`** flags correlated gaps — see [Realtime delivery miss triage](#realtime-delivery-miss-triage-grader-mean-vs-p95). |
| Messages | `message_post_response_total`, `message_post_idempotency_poll_total`, `message_post_idempotency_poll_wait_ms`, `message_cache_bust_failures_total`, `message_channel_insert_path_total`, `message_channel_insert_path_precall_ms` | POST outcomes; idempotency duplicate-lease polls (`outcome=replay_201|exhausted_409`) and wait histogram; cache bust issues; per-request channel insert path vs precall time. |
| Unread counts | `unread_counts_shed_total`, `unread_counts_coalesced_total` | `GET /api/v1/unread-counts` pressure behavior: sheds by `reason` (`pool_waiting`, `inflight_cap`) and per-user in-flight coalescing reuse count. |
| Read receipts (insert lock) | `read_receipt_shed_total{reason="message_channel_insert_lock_pressure"}`, `read_receipt_requests_total{result="deferred_message_channel_insert_lock_pressure"}`, `message_channel_insert_lock_total`, `message_channel_insert_lock_wait_ms`, `message_channel_insert_lock_pressure_wait_p95_ms`, `message_channel_insert_lock_pressure_recent_timeout_count` | Soft-defer `PUT /messages/:id/read` under per-process lock pressure; see [`history/canary-read-receipt-insert-lock-shedding.md`](history/canary-read-receipt-insert-lock-shedding.md). |
| Optional RUM | `client_web_vital_*`, `client_rum_batches_total` | Browser-side; requires `ENABLE_CLIENT_RUM` + built frontend flags. |
| Memory | `process_resident_memory_bytes{job="chatapp-api"}` | **Per Node process** (each `chatapp@` port is a target). **`ChatAppHighMemoryUsage`** in [`alerts.yml`](../infrastructure/monitoring/alerts.yml) fires when RSS **> ~650 MiB for 10m** per target — tune if VM RAM or worker count changes. Grafana overview panel overlays the same threshold. |

## Example PromQL (instant or range)

Use these in Prometheus **Graph** or in `scripts/metrics/metrics-snapshot.sh` (overlapping queries are included there).

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

# Observed app load (completed + aborted)
sum(rate(http_server_requests_total{job="chatapp-api",route!="/metrics",route!="/health"}[5m]))
  + sum(rate(http_server_requests_aborted_total{job="chatapp-api",route!="/metrics",route!="/health"}[5m]))

# Overload
max(chatapp_overload_stage{job="chatapp-api"})

# Realtime fanout stage p95
histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))

# Realtime candidate audience p95 (before recent-connect filtering / inline publish)
histogram_quantile(0.95, sum by (le, path) (rate(fanout_target_candidates_bucket{job="chatapp-api"}[5m])))

# Active connected realtime targets p95
histogram_quantile(0.95, sum by (le, path) (rate(ws_active_subscriber_targets_bucket_bucket{job="chatapp-api"}[5m])))

# Offline targets skipped before realtime publish + Redis EXISTS probe rate
sum by (path) (rate(ws_fanout_offline_skipped_total{job="chatapp-api"}[5m]))
sum by (path) (rate(redis_exists_by_path_total{job="chatapp-api"}[5m]))

# Cross-path duplicate candidates suppressed by recipient dedupe
sum by (path) (rate(ws_recipient_duplicate_candidates_total{job="chatapp-api"}[5m]))

# WS bootstrap breadth p95
histogram_quantile(0.95, sum by (le) (rate(ws_bootstrap_channels_bucket{job="chatapp-api"}[5m])))

# Channel POST /messages insert path mix (each request increments once; sum over reason_detail per path)
sum by (path) (rate(message_channel_insert_path_total{job="chatapp-api"}[5m]))
  / sum(rate(message_channel_insert_path_total{job="chatapp-api"}[5m]))

# p99 precall (queue + Redis spin) by insert path
histogram_quantile(0.99, sum by (le, path) (rate(message_channel_insert_path_precall_ms_bucket{job="chatapp-api"}[5m])))

# WS: realtime_success_rate and replay_fallback_rate (reliable deliveries post-dedupe)
100 * sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="realtime"}[5m]))
  / clamp_min(sum(rate(ws_reliable_delivery_total{job="chatapp-api"}[5m])), 1e-9)
100 * sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="replay"}[5m]))
  / clamp_min(sum(rate(ws_reliable_delivery_total{job="chatapp-api"}[5m])), 1e-9)

# Replay breakdown: missed DB vs pending-queue drain
sum by (source) (rate(ws_reliable_delivery_total{job="chatapp-api",path="replay"}[5m]))

# p95 delivery lag from message/event reference time → socket (by path)
histogram_quantile(0.95, sum by (le, path) (rate(ws_reliable_delivery_latency_ms_bucket{job="chatapp-api"}[5m])))

# Correlate replay spikes: same instant() as Redis memory + fanout p95 + reconnect rate
max(redis_memory_used_bytes{job="redis"}) / max(redis_memory_max_bytes{job="redis"})
sum(rate(ws_reconnects_total{job="chatapp-api"}[5m]))
histogram_quantile(0.95, sum by (le, path, stage) (rate(fanout_publish_duration_ms_bucket{job="chatapp-api"}[5m])))
```

## Optional edge-ingress metric (nginx exporter)

For this app type, compare edge ingress vs app-observed throughput on the same dashboard row:

- **App observed req/s:** `http_server_requests_total + http_server_requests_aborted_total`
- **Edge ingress req/s:** `nginx_http_requests_total` (requires nginx exporter scrape)

Default repo config keeps nginx scraping disabled. To enable:

1. run nginx prometheus exporter on each edge/app host (default listen **`:9113`**)
2. uncomment/add `job_name: 'nginx'` in [`infrastructure/monitoring/prometheus.yml`](../infrastructure/monitoring/prometheus.yml) (local) or host Prometheus config used in prod/staging
3. reload Prometheus and confirm `up{job="nginx"}`

When not enabled, dashboard panels that include `nginx_http_requests_total` should be treated as optional and may show 0/empty.

## Realtime delivery miss triage (grader: mean vs p95) {#realtime-delivery-miss-triage-grader-mean-vs-p95}

When **average** end-to-end delivery (or grader-reported delivery) **spikes** while **p95** HTTP or fanout stays **flat**, the usual story is: **most** messages are fast on the live path, but a **fraction** arrive only after **deferred user-topic publish**, **async fanout job** delay, **reconnect replay**, or **pending-queue drain**. Use the metrics below over the **same** time range.

### 1) Path split and replay fallback

| Quantity | PromQL / series |
|----------|-----------------|
| Realtime delivered (count / s) | `sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="realtime"}[5m]))` |
| **Realtime by Redis topic prefix** (channel-first migration) | `sum by (topic_prefix) (rate(ws_reliable_delivery_topic_total{job="chatapp-api",path="realtime"}[5m]))` — `topic_prefix` is `channel`, `user`, `conversation`, `community`, `userfeed`, or `other` |
| Replay delivered (count / s) | `sum(rate(ws_reliable_delivery_total{job="chatapp-api",path="replay"}[5m]))` |
| **Replay fallback rate** | `100 * sum(rate(ws_reliable_delivery_total{path="replay"}[5m])) / clamp_min(sum(rate(ws_reliable_delivery_total[5m])), 1e-9)` |
| **Replay by topic prefix** (channel vs DM vs user feed) | `sum by (topic_prefix) (rate(ws_reliable_delivery_topic_total{job="chatapp-api",path="replay"}[5m]))` |
| **Pending classify: second-probe rescues** | `sum by (mode) (rate(pending_replay_second_probe_recent_user_total{job="chatapp-api"}[5m]))` — `conversation_marker` vs `legacy_global` |
| **Realtime success rate** | `100 * sum(rate(ws_reliable_delivery_total{path="realtime"}[5m])) / clamp_min(sum(rate(ws_reliable_delivery_total[5m])), 1e-9)` |
| Delivery timeout (post-insert) | `sum by (phase) (rate(delivery_timeout_total{job="chatapp-api"}[5m]))` — today mainly **`phase=cache_bust`** (bounded wait after commit; see POST /messages path) |
| Miss / stress signals | `sum by (reason) (rate(realtime_miss_attribution_total{job="chatapp-api"}[5m]))` |
| Channel user-topic **deferred** volume | `sum(rate(channel_message_fanout_recipient_total{segment="deferred_user_topic"}[5m]))` vs **`inline_user_topic`** |

### 2) Classifying “misses” (instrumented vs inferred)

Exact per-recipient “why” is not always observable on one worker (userfeed shards, multi-`chatapp@`). Use this mapping:

| Cause | How you see it |
|-------|----------------|
| **Recipient disconnected** | Loki: `ws.disconnect` / close codes; **`ws_disconnects_total`**; **`ws_reconnect_gap_ms`**; replay **`source=missed_db`** rising after disconnect logs |
| **Recipient reconnecting** | **`ws_reconnects_total`** with replay **`path=replay`**; **`ws_bootstrap_wall_duration_ms`** high in same window |
| **Recipient subscribed late / not recent-connect inline** | **`realtime_miss_attribution_total{reason="channel_user_topic_deferred_not_recent"}`** (recipient count not published inline to `user:<id>`; deferred to **`fanout.channel_message.user_topics`**). Requires **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`**, **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=false`** |
| **Fanout target missing / stale audience** | **`fanout_target_cache_total{path="channel_message_user_topics",result="miss"}`** spikes; **`conversation_fanout_targets_cache_version_retry_total`**; DM target lookup **`fanout_publish_duration_ms`** `conversation_event` / `conversation_dm` **`target_lookup`** |
| **Redis pub/sub delay** | **`fanout_publish_duration_ms`** by **`path`** and **`stage`**; **`redis_fanout_publish_failures_total`**; Redis **SLOWLOG** / **`redis_commands_processed_total`** / memory (see snapshot script) |
| **Worker: local socket not found** | Not a single counter (normal cross-worker). Infer from **replay** + **deferred** + **zero local subscribers** on the **channel** topic only in **single-worker** or canary setups |
| **Backpressure / drop** | **`ws_backpressure_events_total`**, **`topic_message_send_blocked`** / **`topic_message_partial_delivery`** on **`realtime_miss_attribution_total`** (local **`channel:`** / **`conversation:`** path: had subscribers but **all** or **some** `sendPayloadToSocket` enqueue failed) |
| **Replay recovered** | **`ws_reliable_delivery_total{path="replay"}`** by **`source`** (`missed_db` vs `pending_queue`) |

### 3) Correlations (same instant or Grafana row)

- **Disconnect / reconnect:** `rate(ws_reconnects_total[5m])`, **`ws_replay_query_duration_ms`**, **`ws_reliable_delivery_total{path="replay"}`**
- **Bootstrap:** **`histogram_quantile(0.95, rate(ws_bootstrap_wall_duration_ms_bucket[5m]))`**, **`ws_bootstrap_list_cache_total`**
- **Deferred POST fanout:** **`fanout_job_latency_ms`**, **`message_post_fanout_job_total`**, **`fanout_queue_depth`**, **`fanout_retry_total`**
- **Redis:** memory ratio, evictions, SLOWLOG (see top of this doc)
- **List cache:** **`sum by (endpoint,result) (rate(endpoint_list_cache_total[5m]))`** — correlate with **`delivery_timeout_total`** / slow GETs after writes

### 4) Top miss cause (operator recipe)

1. If **`channel_user_topic_deferred_not_recent`** dominates → **recent-connect / subscribe ordering** vs **deferred user-topic** path (see fixes below).
2. If **`topic_message_send_blocked`** or **`ws_backpressure_events_total`** rises → **slow consumers** or outbound queue caps.
3. If **`fanout_target_cache_total` miss** + retries → **stale or incomplete fanout audience** until cache/coalesce settles.
4. If **`message_post_fanout_job_total{result="dead_letter"}`** or **`redis_fanout_publish_failures_total`** → **async fanout / Redis**; replay and pending queue absorb gaps.
5. If **`ws_reliable_delivery_total{path="replay",source="pending_queue"}`** with **`ws_pending_replay_guard_total`** → **Redis memory guard** skipping pending enqueue.

### 5) Lowest-risk fixes (ordered)

| Fix | Risk | When it helps | Expected impact on grader spikes |
|-----|------|----------------|----------------------------------|
| **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`** (or keep default blocking in prod) so **all** user-topic publishes run **before** HTTP 201 returns | Low–medium (more POST tail latency) | **`channel_user_topic_deferred_not_recent`** and deferred **`fanout_recipient`** ratio high | **High** on mean delivery: removes deferred-queue tail for channel members |
| Keep **`CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect`** with **`CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true`** only after the bootstrap-pending bridge is deployed; set skip **`false`** as rollback if userfeed misses return | Low–medium | Redis pub/sub pressure from duplicate userfeed publishes while preserving the bootstrap gap bridge | **High** on latency spikes from duplicate publish volume |
| **Tighter bootstrap** (marks **`markChannelRecentConnect`** and `channel:bootstrap_pending:<id>` before batched **`subscribeClient`**, then clears pending after channel subscribe) — only tune if logs show a wider hydration gap; optional **`WS_BOOTSTRAP_*`**, **`RECENT_CONNECT_TARGET_CACHE_MS`** tuning | Low | Rare race before direct channel subscription hydrates | **Small** |
| Shorter **`CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS`** or rely on existing membership invalidation | Low | **`fanout_target_cache` miss** spikes with wrong audience | **Medium** when cache staleness is proven |
| **Do not** add blind “retry publish for online recipients not found locally” without cross-worker idempotency — **high** duplicate risk | High | — | — |
| **Immediate replay after reconnect** — already **`replayPendingMessagesToSocket`** + **`replayMissedMessagesToSocket`**; tune **`WS_MESSAGE_REPLAY_*`** only with load testing | Medium | Replay latency tail, not mean | **Medium** on tail only |

**Expected reduction:** If spikes are driven by **deferred user-topic** (common when **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=false`** with **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`**), setting blocking **on** (staging/prod required env already does) usually **collapses the slow tail**. If blocking is already **on**, check **`MESSAGE_POST_SYNC_FANOUT`** / **`fanout_job_latency_ms`** p99 and **`message_post_fanout_job_total{result="dead_letter"}`**. If spikes are **replay**, fix **disconnect/bootstrap** or **Redis/fanout** first.

### Pending replay Redis footprint (`ws:pending:user:*`)

**Channel `message:created`:** after **`channel:<id>`** publish, **`enqueuePendingMessageForUsers(pendingEnqueueTargets, …)`** receives the channel fanout bridge targets. In **`all`** mode this is the capped visible-member list. In **`recent_connect`** mode it is the active/recent bridge; when **`CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true`**, that bridge is further narrowed to users still present in **`channel:bootstrap_pending:<channelId>`** because hydrated sockets already receive the direct **`channel:<id>`** publish. Bootstrap, community join, and private-channel invite paths add this marker before pushing internal subscribe commands; `subscribeClient` clears it when the socket actually joins the channel. **`filterUsersEligibleForPendingReplay`** then keeps only **connected** or **recent-marker** users, so offline members are not written. **DM `message:created`:** **`enqueuePendingMessageForUsers(userIds, …)`** receives conversation participant user ids from **`publishConversationEventNow`** (no `recentTargets` hint). With **`WS_PENDING_ELIGIBLE_LEGACY_FALLBACK=false`**, the server still runs the **conversation marker fallback** by default: a second **`EXISTS ws:recent_connect:*` / `ws:replay_pending_eligible:*`** pass for phase‑1 misses (channel fanout passes explicit `recentTargets` and stays single‑phase). Disable with **`WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK=false`**.

**Recipient classes (filtering mode, default on):**

| Class | Redis / meaning | Gets `ws:pending:user:*` ZADD? |
|-------|-------------------|--------------------------------|
| **connected** | `SCARD user:<id>:connections > 0` (WS on any worker) | Yes |
| **recent** | No active socket, but `EXISTS ws:recent_connect:<id>` or `ws:replay_pending_eligible:<id>` (set on connect; TTL = **`WS_RECENT_CONNECT_TTL_SECONDS`** / **`WS_REPLAY_RECENT_USER_WINDOW_SECONDS`**) — *recently disconnected / reconnect bridge* | Yes |
| **offline** | Neither marker nor connections | **No** (skipped) |

**Metrics:** **`pending_replay_recipient_total{class}`** (`connected`, `recent`, `offline_skipped`, `legacy_enqueue`), **`pending_replay_second_probe_recent_user_total{mode}`** (`conversation_marker` = targeted DM path when global legacy is off; `legacy_global` = second probe under **`WS_PENDING_ELIGIBLE_LEGACY_FALLBACK=true`**), **`pending_replay_entries_per_message`**, **`offline_pending_skipped_total`**, **`ws_pending_user_zset_size`** (ZSET cardinality after enqueue). **Replay mix by logical topic:** **`ws_reliable_delivery_topic_total{path="replay"}`** by **`topic_prefix`** (`channel`, `conversation`, `user`, …). **Rates:** **`realtime_success_rate`** and **`replay_fallback_rate`** from **`ws_reliable_delivery_total`** (see snapshot script / Example PromQL).

**Spec:** Pending replay is **not** the source of durable history or unread counts — Postgres and normal app paths are. Skipping pending for offline users does **not** change read receipts, unread aggregates, or REST history.

**Rollback:** **`WS_REPLAY_PENDING_LEGACY_ALL=true`** restores enqueue-for-all fanout targets (old Redis mailbox behavior).

## Auth login/register stampede

Per-credential rate limits use **IP + username/email** as the Redis key. A harness that logs in as **many different synthetic users from one or a few IPs** effectively gets **one bucket per user**, so aggregate traffic can reach **hundreds of req/s** and saturate bcrypt + the event loop (Grafana: `route=/api/v1/auth/login`, `nodejs_eventloop_lag_p99` up, nginx **504**).

**Register:** **`register_global_ip`** is **always on** (tunables **`AUTH_REGISTER_GLOBAL_PER_IP_*`**) so unique-username registration floods still hit a per-IP cap. **Login:** set **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`** to enable **`login_global_ip`** and **`AUTH_LOGIN_GLOBAL_PER_IP_*`** when many distinct users share one source IP (see [`env.md`](env.md)). **`DISABLE_RATE_LIMITS=true`** disables all auth limiters (grading-only).

## Synthetic probe (host alert)

`chatapp_synthetic_probe_success` comes from [`scripts/ops/synthetic-probe.sh`](../scripts/ops/synthetic-probe.sh) via node_exporter textfile — see `runbooks.md` (ChatAppSyntheticProbeFailed).

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
