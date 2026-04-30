# Runbooks (ChatApp)

Status: operational
Owner: platform-operations
Last reviewed: 2026-04-30

Short actions for alerts in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml). Replace hostnames with your environment.

**Documentation hub (canonical sources, env drift rules):** [`README.md`](README.md).

**Agent diagnosis workflow (SSH, logs, profiling, improvement rubric):** [`agent-operations-playbook.md`](agent-operations-playbook.md).

**Metric names, PromQL, and how to export a snapshot for debugging:** [`operations-monitoring.md`](operations-monitoring.md).

**Production deploy baseline:** `deploy-prod.sh` / `deploy-prod-multi.sh` merge git-tracked [`deploy/env/prod.required.env`](../deploy/env/prod.required.env) into `/opt/chatapp/shared/.env` on every rollout. Deploying an **older SHA** or a fork that never merged `origin/main` can **revert** realtime/search/replay behavior (fanout mode, WS replay limits, search semantics). Prefer **prod from current `origin/main`** (or a release tag cut from it); after deploy, spot-check `readlink /opt/chatapp/current` and that required keys in the merged `.env` match the profile you expect.

**Canary (read receipt shedding vs insert-lock pressure):** [`history/canary-read-receipt-insert-lock-shedding.md`](history/canary-read-receipt-insert-lock-shedding.md) — **prod VM3 first** (`PROD_USER=ubuntu DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh <sha>`), 10–15m soak, PromQL `vm3` vs `vm1|vm2`; POST **503** flat/down + correctness are the hard gates (zero read defers during low pressure is OK).

## ChatAppSyntheticProbeFailed

Fires when the **host-local** synthetic probe (see [`scripts/ops/synthetic-probe.sh`](../scripts/ops/synthetic-probe.sh), `TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile`) reports **`chatapp_synthetic_probe_success == 0`** for 10 minutes. This is **not** the COMPAS harness; it is a curl to **`http://127.0.0.1/health`** through normal routing.

1. `curl -fsS -v http://127.0.0.1/health` on the VM.
2. `systemctl status 'chatapp@*'` and nginx `error.log` for upstream errors.
3. **`deploy-prod.sh`** installs `/opt/chatapp-monitoring/synthetic-probe.sh` and an **idempotent** crontab entry (every 2 minutes, `TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile`). If cron is missing, re-run a prod deploy or add that line manually for the deploy user.

## ChatAppTrafficCliffWhileInstancesUp

Fires when Prometheus still scrapes at least one `chatapp-api` target but **completed HTTP traffic** (from `http_server_requests_total`) is **below 20% of the rate 15 minutes ago**, and the prior rate was above **~40 req/s**. This is **not** a deploy signal by itself.

1. Confirm **no deploy** in the window: `journalctl -t chatapp-deploy --since '2026-04-13 14:00:00' --until '2026-04-13 15:00:00'` (adjust UTC).
2. **Compare ingress vs app:** on the VM, `zgrep` nginx `access.log` for **requests per minute** in the incident window — if edge volume collapsed, the bottleneck is **load generators / network path** to the site, not necessarily Node.
3. **5xx panels** can stay flat: if clients stop sending requests, you see a **traffic cliff** with **no** `ChatAppHigh5xxRate`.
4. Optional: run a probe **outside** the harness — [`scripts/ops/synthetic-probe.sh`](../scripts/ops/synthetic-probe.sh) against the public `/health`. If it stays green while Grafana RPS drops, the API process path is likely fine.

Tune or silence this alert if your normal traffic pattern routinely drops >80% in 15 minutes (e.g. end of graded window).

## ChatAppApiDown / ChatAppApiDownFast

1. Check HTTP: staging `http://<staging-host>/health`, prod course URL `/health`.
2. On the VM: `systemctl status 'chatapp@*'` and `journalctl -u 'chatapp@*' -n 80`.
3. Nginx: `sudo grep -E 'no live upstreams|upstream' /var/log/nginx/error.log | tail -20`.
4. Verify Postgres and Redis reachable from the app (connection strings, PgBouncer).
5. If deploy just finished, confirm rollout order: DB migrate → API → nginx reload.

## ChatAppProcessRestartFlapping

1. `journalctl -u 'chatapp@*' --since '30 min ago'` for OOM, uncaught exceptions, or DB errors.
2. Check disk and memory: `df -h`, `free -h`.
3. Temporarily reduce load or scale instances if available.

## Brief nginx 502 on `POST` during production deploy

If **`sendMessage`** (or other `POST /api/`) returns **502 HTML from nginx** for a few seconds **during** a dual-worker rollout: nginx’s default **`proxy_next_upstream`** does **not** retry **POST** when the first upstream is **connection refused** (companion restart). **`deploy-prod.sh`** now defaults **`PIN_CANDIDATE_BEFORE_COMPANION=true`** and ensures **`proxy_next_upstream`** for **`/api/`** (and auth) includes the **`non_idempotent`** keyword (not a separate directive). Re-run a deploy after pulling that script, or patch nginx manually to match [`deploy/nginx/staging.conf`](../deploy/nginx/staging.conf).

## ChatAppHigh5xxRate / ChatAppFast5xxBurn

1. Correlate with deploy time and **`FORCE_OVERLOAD_STAGE`** / load shedder in logs.
2. Identify route from metrics label `route` on histograms or access logs.
3. If shedder active, scale capacity or reduce client burst (rate limits).

## ChatApp5xxAbsoluteRate

Fires when **completed** 5xx responses stay above ~0.25/s (5m rate) for 4 minutes — catches steady errors even when **ratio** to all traffic is below 5% (e.g. heavy grader load).

1. Same triage as **ChatAppHigh5xxRate**; check Grafana **5xx absolute rate (req/s)** panel.
2. Postgres `42P01` / missing relations → deploy or `DATABASE_URL` mismatch, not “overload” alone.

## ChatAppSevereP95Latency

**Critical** — p95 above 5s for 5 minutes on a route. Discord routes to `@here` via `discord-critical`.

1. Inspect `pg_pool_waiting`, fanout queue depth, event-loop lag on the same dashboard.
2. Compare with nginx/upstream timeouts if clients see 502/504 without Node metrics moving.

## ChatAppHighP95Latency

1. Check hot routes; inspect DB slow queries and Redis latency.
2. Compare with k6 `slo` summary from the same week.
3. If **errors or latency spike while RPS is flat** (tail-latency regime), run [`scripts/postgres/prod-pg-stat-activity.sh`](../scripts/postgres/prod-pg-stat-activity.sh) on the DB host during the spike — longest `pg_stat_activity` rows surface unbounded worst-case queries and wait events without guessing.

## Discord did not notify but the app looked unhealthy

Prometheus must **fire** an alert; Alertmanager must **deliver** it. Common gaps:

1. **`for:` duration** — e.g. **ChatAppHigh5xxRate** needs more than **5%** 5xx for **10 minutes**; brief deploy spikes may never qualify. **ChatAppFast5xxBurn** uses a **2m** window (threshold **6%** ratio).
2. **Metric blind spots** — rules use **`job="chatapp-api"`** and **completed** HTTP responses. Nginx-only **502/504**, scrape outages, or errors not recorded on `http_server_requests_total` will not trigger these alerts.
3. **Alertmanager** — confirm the running config matches [`infrastructure/monitoring/alertmanager.yml`](../infrastructure/monitoring/alertmanager.yml), webhook secret is mounted, and no **Silences** cover `alertname=~"ChatApp.*"`.
4. **Grafana `sum(ALERTS{...})`** is a **count** of firing alert series — if a panel shows **“%”** on the axis, fix the panel unit (should be **none** or **short**), or you will misread the graph.

**Verify in Prometheus:** paste the `expr` from `ChatAppFast5xxBurn` / `ChatApp5xxAbsoluteRate` into **Graph** for the incident time range and check whether the line crossed the threshold for the full **`for`** window.

## ChatAppEventLoopLagHigh

1. CPU-heavy work on main thread; check for synchronous crypto, large JSON, or logs at `debug`.
2. Heap snapshots if memory correlates (see memory alert).

## ChatAppHighMemoryUsage

1. Confirm trend; if growing, plan restart window and investigate leaks.
2. **Per process:** rule uses `process_resident_memory_bytes` per `chatapp-api` target (~650 MiB × **each** worker). Compare host **MemAvailable** / **MemTotal** (node_exporter) to total RSS of all API processes.
3. Tune alert threshold in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) if VM RAM or instance count changed.

## ChatAppSyntheticProbeMetricMissing

1. On the host: `ls -l /opt/chatapp-monitoring/node_exporter_textfile/` and confirm the synthetic probe output file is updating.
2. Run probe manually: `TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile /opt/chatapp-monitoring/synthetic-probe.sh`.
3. Verify node exporter textfile collector path and service health (`systemctl status prometheus-node-exporter`).
4. If probe runs but metric is absent, restart exporter and confirm `curl -sS http://127.0.0.1:9100/metrics | grep chatapp_synthetic_probe_success`.

## ChatAppPgPoolPressure Family

Applies to: `ChatAppPgPoolWaitingNonZero`, `ChatAppPgPoolPressure`, `ChatAppPgPoolWaitSpikeFast`, `ChatAppPgPoolSevereSaturation`, `ChatAppPgPoolCircuitOpenSustained`, `ChatAppPgPoolMostlyCheckedOut`, `ChatAppPgQueryGateRejects`, `ChatAppPgPoolOperationErrors`, `ChatAppHighDbQueriesPerRequest`.

1. Check pressure shape first:
   - `max(pg_pool_waiting{job="chatapp-api"})`
   - `sum(rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}[5m]))`
   - `sum(rate(pg_pool_operation_errors_total{job="chatapp-api"}[5m]))`
2. Correlate with DB host stress (`db-node` iowait, disk, CPU) and current request rate; if queueing rises while RPS is flat, prioritize DB contention/root query cause.
3. Capture query evidence:
   - `PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/postgres/pg-stat-statements-snapshot.sh`
   - `PROD_DB_SSH=ubuntu@130.245.136.21 DB_NAME=chatapp_prod bash scripts/postgres/prod-pg-stat-activity.sh`
4. Mitigate in this order: reduce burst/load, increase DB headroom, then tune app pool/concurrency. Avoid only increasing app workers when pool waiting is already high.

## ChatAppOverloadSheddingActive / ChatAppOverloadSheddingCritical

1. Confirm stage and slope: `max(chatapp_overload_stage{job="chatapp-api"})` and `sum(rate(http_overload_shed_total{job="chatapp-api"}[5m]))`.
2. Stage 2 (`shed-search`) is warning; stage 3 (`shed-writes`) is critical and should be treated as immediate capacity action.
3. Check paired symptoms (`pg_pool_waiting`, event-loop lag, 5xx, fanout queue depth) to locate bottleneck before changing thresholds.
4. If incident-driven override is needed, document any `FORCE_OVERLOAD_STAGE` usage and remove as soon as pressure stabilizes.

## ChatAppHostPressure Family

Applies to: `ChatAppHostCpuHigh`, `ChatAppHostLoadPerCoreHigh`, `ChatAppHostIoWaitHigh`, `ChatAppDbHostIoWaitHigh`, `ChatAppHostMemoryPressure`, `ChatAppHostSwapIoHigh`, `ChatAppCpuSaturationHigh`.

1. Validate host vs app cause:
   - host: `top`, `vmstat 1 10`, `iostat -x 1 10`, `free -h`, `df -h`
   - app: event-loop lag, process RSS, route latency/5xx
2. If host pressure is isolated to one VM, drain or reduce traffic to that node before global tuning.
3. If DB iowait is elevated with pool waiting, treat as DB-first bottleneck and follow `ChatAppPgPoolPressure Family`.
4. Record whether issue is transient deploy churn vs sustained capacity ceiling before resizing.

## ChatAppDiskSpaceLow / ChatAppDbDiskSpaceLow / ChatAppDbDiskSpaceCritical

1. Confirm exact mount and host from alert labels (`job`, `instance`, `mountpoint`); avoid conflating staging vs prod.
2. Check usage directly:
   - app/host root: `df -h /`
   - DB root: `ssh ubuntu@<db-host> 'df -h /'`
3. For DB incidents, inspect largest relation/index growth:
   - `sudo -u postgres psql chatapp_prod -c "SELECT pg_size_pretty(pg_total_relation_size('messages'))"`
   - `sudo -u postgres psql chatapp_prod -c "\di+"`
4. Mitigate by expanding volume first when near critical; only drop/prune DB objects with explicit rollback plan.

## ChatAppDbPostgresExporterDown

1. On DB host: `systemctl status prometheus-postgres-exporter` (or service name used by deploy scripts).
2. Validate exporter DSN/env and local endpoint: `curl -sS http://127.0.0.1:9187/metrics | head`.
3. Confirm monitoring VM can scrape DB `:9187` (firewall/VPC path).
4. If exporter is down but DB is healthy, classify as observability incident and avoid paging app owners as DB outage.

## ChatAppRealtimeDeliveryFailures Family

Applies to: `ChatAppCriticalFanoutQueueBacklog`, `ChatAppCriticalFanoutQueueDelayHigh`, `ChatAppMessagePostFanoutJobLatencyP99High`, `ChatAppMessagePostFanoutJobLatencyP999High`, `ChatAppMessagePostRealtimePublishFailures`, `ChatAppRedisFanoutPublishFailures`, `ChatAppWsReplayFailOpenRateHigh`, `ChatAppRealtimeFanoutSlow`, `ChatAppDeliveryFailsWarning`, `ChatAppDeliveryFailsFastBurn`, `ChatAppMessagePostFanoutQueueFull`, `ChatAppFanoutCriticalQueueSustainedBacklog`, `ChatAppWsBackpressure`, `ChatAppWsBootstrapSlow`, `ChatAppWsUnauthorizedBurst`, `ChatAppMessagePost401RateHigh`.

1. Determine if failures are write-path, fanout-path, or client-auth path:
   - write-path: `/api/v1/messages` 5xx/401 mix and `message_post_response_total`
   - fanout-path: queue depth/delay, `fanout_job_latency_ms`, publish failure counters
   - client path: WS unauthorized/reconnect/backpressure
2. Check Redis health and latency concurrently (`redis_up`, used/max memory, evictions, SLOWLOG if available).
3. If queue depth grows with low publish throughput, scale side-effect capacity and reduce fanout work before raising retry budgets.
4. For grader-impacting regressions, use `scripts/grader/grader-watch-gate.sh` and correlate timestamps with Prometheus/Loki.

## ChatAppRedis Health Family

Applies to: `ChatAppRedisExporterDown`, `ChatAppRedisMemoryHigh80`, `ChatAppRedisMemoryHigh90`, `ChatAppRedisMemoryHigh95`, `ChatAppRedisClientsElevated`, `ChatAppRedisExporterNotReady`, `ChatAppRedisEvictionsNonZero`, `ChatAppRedisRejectedConnections`, `ChatAppRedisAclDeniedOperations`, `ChatAppRedisRdbOrAofLoadingStall`, `ChatAppRedisOOMRiskComposite`.

1. Confirm exporter vs Redis distinction first:
   - exporter down != Redis down
   - `redis_up` + direct `INFO` determine Redis availability
2. For memory pressure, inspect used/maxmemory, eviction rate, and client count before changing policy.
3. For ACL/rejected connections, verify app/exporter credentials and source network policy changes.
4. Critical memory alerts (90/95/OOM composite) require immediate headroom action (raise maxmemory/resize or reduce key volume).

## WebSocket / fanout

If realtime is broken but REST is healthy:

1. Confirm nginx upgrades WebSocket (`Upgrade`, `Connection`) per deploy config.
2. Run [`deploy/candidate-ws-smoke.cjs`](../deploy/candidate-ws-smoke.cjs) against candidate URL if available.
3. Inspect fanout queue metrics and logs in [`backend/src/messages/sideEffects.ts`](../backend/src/messages/sideEffects.ts) paths.

## Grader-oriented delivery checks

**Course definitions** (15s per listener, outage windows): [`architecture/grading-delivery-semantics.md`](architecture/grading-delivery-semantics.md).

Automated graders (browser clients) should treat **HTTP as the source of truth** for whether a message exists, not the DOM immediately after `POST /messages` returns.

1. **Preferred:** After a successful write (`201`), call **`GET /messages?channelId=…` or `GET /messages?conversationId=…`** and assert the new message id or content appears on the first page. The API awaits Redis eviction of the first-page cache before responding on create/update/delete and on group invite/leave system rows; the web client also skips its short in-memory GET cache for `/messages` paths (see [`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts)).
2. **If checking the UI only:** For **`POST /messages`** (`message:created`) and for **`PATCH` / `DELETE` on a message**, the server **awaits `fanout.publish`** before returning, so the UI can update immediately after success on those routes. **`read:updated`** and some other paths may still use the in-process fanout queue — for those, a **short wait** or **GET** assertion is safer than WS-only zero-wait.
3. **Do not** rely solely on WebSocket delivery for grading unless you accept occasional false negatives under normal load.

**Throughput harnesses:** channel **`message:created`** is duplicated to **`user:<member>`** by default so listeners receive it as soon as the **`user:`** Redis subscription is live (before full **`channel:`** bootstrap). The generated grading client currently does **not** wait for WS `ready` and does **not** explicitly subscribe to `channel:` / `conversation:` topics, so when you debug “delivery timeout” reports, first reason about **`user:<self>` compatibility** rather than rich-client pane state. See [`architecture/grading-delivery-semantics.md`](architecture/grading-delivery-semantics.md). Watch **`ws_bootstrap_wall_duration_ms`** if accounts have extreme community counts.

## Metrics during grader or load-test runs

When investigating **delivery fails**, **peak rate**, or tail latency under many concurrent browser sessions, correlate with:

**Capacity bottleneck (typical):** **`pg_pool_waiting`**, **`query timeout`** in API logs, and pool circuit-breaker **503**s point to **Postgres / PgBouncer** saturation before Redis or nginx. See [operations-monitoring.md](operations-monitoring.md) (“Where latency comes from”).

| Metric | What it indicates |
|--------|-------------------|
| `side_effect_queue_depth{job="chatapp-api",queue="fanout:critical"}` | Backlog of Redis publish jobs for message/read fanout; sustained growth means realtime lag. |
| `side_effect_queue_delay_ms` (histogram) | Time from enqueue to running the fanout job; high p95 means delayed WS delivery after writes. |
| `ws_backpressure_events_total{job="chatapp-api"}` | Server dropped a frame or closed a socket because the client could not drain the WS buffer fast enough. |
| `ws_bootstrap_wall_duration_ms` | Wall time to finish auto-subscribe batches; very high values correlate with missed **`channel:`**-only delivery before **`user:`** duplicate existed or when fanout is disabled. |

Related alerts: [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) (for example critical fanout backlog and delivery degradation rules).

Grafana **ChatApp Overview** ([`infrastructure/monitoring/grafana-provisioning/dashboards/files/chatapp-overview.json`](../infrastructure/monitoring/grafana-provisioning/dashboards/files/chatapp-overview.json)) includes a **Grader / delivery debugging** section: WebSocket backpressure, `message_post_response_total`, fanout queue depth/delay, pool waiting, `/api/v1/messages` HTTP mix, overload stage, and client-aborted requests.

**Before release / after delivery changes:** run `cd backend && npm test` (full suite). For a staging grader-style load, compare **POST `/messages` p95/p99** (synchronous fanout adds latency) with **`ws_backpressure_events_total`** and fanout queue depth above.

## Automated grader dashboard watcher (rollout gate)

Use a local authenticated watcher to detect grader-side delivery regressions within seconds during rollout soak windows.

1. One-time browser login bootstrap (headed):

   ```bash
   cd frontend
   npm run grader:watch:headed
   ```

   Sign in to the grader dashboard in the opened browser window, then stop the watcher (`Ctrl+C`). The session is stored in `frontend/.playwright/grader-user-data`.

2. Continuous monitor during rollout:

   ```bash
   cd frontend
   npm run grader:watch
   ```

   If campus SSO/2FA blocks the isolated Playwright profile, attach to your own logged-in Chrome session:

   ```bash
   open -na "Google Chrome" --args --remote-debugging-port=9222
   npm run grader:watch:cdp
   ```

   This polls the dashboard every 15s and writes:
   - `artifacts/rollout-monitoring/grader-watch-events.jsonl` (append-only timeline)
   - `artifacts/rollout-monitoring/grader-watch-latest.txt` (current error block snapshot)

3. Use for gated 1->2->4 scale-up:
   - Keep watcher running during each soak window.
   - Treat any new `sendMessage failed: 5xx`, `Delivery timeout`, or repeated 403 bursts as an abort signal.
   - Correlate event timestamps with `scripts/ops/prod-harness-window.sh`, `scripts/ops/prod-nginx-audit.sh`, and Prometheus snapshots.

4. Enforce watcher as a rollout gate:

   ```bash
   ./scripts/grader/grader-watch-gate.sh --window-seconds 900
   ```

   Exit code is non-zero when recent watcher events include critical delivery errors (`Delivery timeout` or `sendMessage failed: 5xx`) or repeated 403s.

   For post-deploy soak monitoring against a long-lived watcher file, prefer anchored novel-only mode so a stale "Last error — 27m ago" refresh does not count as a new regression:

   ```bash
   ./scripts/grader/grader-watch-gate.sh --since "2026-04-17T14:10:40Z" --novel-only
   ```

   `--novel-only` only fails on critical signatures that did not already exist before the anchor time.

5. One-shot bundle (local, before prod or after a risky merge): from repo root run `npm run verify:release` — backend tests, staging API contract, deploy script checks, and the grader gate when `artifacts/rollout-monitoring/grader-watch-events.jsonl` exists (use `SKIP_GRADER_WATCH_GATE=1` outside an active soak, or archive a stale events file so the gate reflects the current window only).

## Harness outage — correlate a specific time window (minute-level)

COMPAS **outage** bands are often **short**. Repo-wide HTTP **5xx%** panels can stay flat while the harness reports **failed deliveries** (WS SLA), so triage needs **logs + journals** on the exact minutes.

1. Read start/end **UTC** from the harness chart (x-axis).
2. From a machine with SSH to prod:

   ```bash
   ./scripts/ops/prod-harness-window.sh '2026-04-12 05:14:00' '2026-04-12 05:22:00'
   ./scripts/ops/prod-harness-window.sh '2026-04-12 05:53:00' '2026-04-12 06:03:00'
   ```

   Optional: widen padding around deploys: `PADDING_MIN=3 ./scripts/ops/prod-harness-window.sh '...' '...'`

   The script prints **`chatapp-deploy`** events, **`chatapp@` journal** (warning+), **nginx error.log** lines (upstream reset/refused/timeout), and an **access.log** status histogram for both a **padded** window and your **strict** harness interval (scans the last **ACCESS_TAIL_LINES** lines of access.log — increase if the window is old).

3. **Grafana / Prometheus** for the same UTC range: zoom the dashboard to the outage; check **event-loop lag p99**, **p95 latency**, **WS accepted rate**, **`http_server_requests_aborted_total`** (if panel exists), **fanout queue wait p95**. Harness failures without **5xx** usually show as **lag + aborts + reconnects**, not **ChatAppHigh5xxRate**.

4. Hour-granular nginx only: [`scripts/ops/prod-log-correlate.sh`](../scripts/ops/prod-log-correlate.sh) (POST `/messages` mix per clock hour).

### Example (prod `group-8`, 2026-04-12) — evidence already pulled

If Grafana shows **traffic drop ~14:35** and **p95 + event-loop spike ~15:55** (axis in **US/Eastern**), these **UTC** journal facts align:

- **`last -x reboot` / `shutdown`:** **18:27–18:28 UTC** — full VM stop/boot (**~14:27–14:28 EDT**).
- **`journalctl -u postgresql`:** **18:57:30–18:57:35 UTC** — PostgreSQL **restart** (**~14:57 EDT**); same minute as **`no live upstreams`** in **`/var/log/nginx/error.log`**.
- **Third band (~15:45–15:55 EDT → 19:45–19:55 UTC):** **no reboot**; **`journalctl` lines from `pgbouncer` (`stats:`)** show **`wait`** in the **multi‑second** range per minute bucket and **`xacts/s`** collapsing (e.g. **~1.1k/s → ~142/s** at **19:50 UTC**). **`grep` of nginx `error.log` for `19:4x` / `19:5x` returned 0** `[error]` lines in that prefix — not the same signature as the **14:57** upstream outage.
- **App logs in that window:** **`23503`** on **`channels_last_message_id_fkey`** from **`repointChannelLastMessage`** (logged at **error** before mitigation). Repo fix: **`repointLastMessage`** now **nulls `last_message_*` and returns** after exhausted FK retries so **`DELETE /messages` does not 500 after the row is already gone**.

**Repeatable snapshot on the VM:** `scripts/ops/prod-capacity-snapshot.sh` (see repo; also validated in CI `bash -n`).

## DM delivery timeout — 2-minute triage (conversationId + missingUserId)

Use when the leaderboard shows **`Delivery timeout | … conversation=<UUID> missing=[username]`**. Replace placeholders: **`CONV`** = conversation UUID, **`USER`** = missing participant’s **user UUID** (resolve username → id from DB or admin if needed).

### Minute 0–1: Redis — was the user “connected”?

Run against the **same Redis** the API uses (`REDIS_URL`). If you use ACL: add `-a "$REDIS_PASSWORD"` to every command below.

1. **Any registered WS connections for that user?**

   ```bash
   redis-cli SMEMBERS "user:USER:connections"
   ```

   - **Empty** → no API node had registered this user’s sockets at Redis write time → classify as **not connected** (or never finished bootstrap / tab killed). Correlate with harness opening WS **after** POST if timing is suspicious.
   - **Non-empty** → copy connection ids (UUID strings), then for **each** id:

   ```bash
   redis-cli EXISTS "user:USER:connection:<connectionId>:alive"
   ```

   - **`1`** on at least one id → strong evidence the server believed a live socket existed recently (TTL window; see `CONNECTION_ALIVE_TTL_SECONDS` in code, default **120s**).
   - **All `0`** → stale connection set (cleanup lag) or connections died just before check → treat as **likely disconnected / replay path**.

2. **Recent disconnect marker (replay eligibility on next connect)?**

   ```bash
   redis-cli GET "ws:recent_disconnect:USER"
   ```

   - **Non-nil JSON** with `disconnectedAt` near the incident → user **was** disconnected around that time; next connect should run DB replay (`ws.replay.missed_messages` in logs).
   - **nil** → no recorded disconnect in TTL window (`WS_RECENT_DISCONNECT_TTL_SECONDS`, default **180s** in `server.ts` unless overridden).

### Minute 1–2: Logs — starved vs killed vs never delivered

On an API host (or centralized log store), narrow to **incident time ±90s** and **`CONV`** / **`USER`**.

1. **DM fanout (HTTP path) — was Redis publish slow?**

   ```bash
   journalctl -u 'chatapp@*' --since '2026-04-19 18:44:00' --until '2026-04-19 18:49:00' \
     | grep -F 'dm_fanout_timing' | grep -F 'CONV'
   ```

   - **`totalMs` tiny** (e.g. under 100 ms) and no Redis errors → server-side publish is unlikely the 15s bottleneck.
   - **Large `lookupMs` / `userfeedWallMs`** → target lookup or Redis publish contention.

2. **Slow consumer kill (TCP buffer huge)?**

   ```bash
   journalctl -u 'chatapp@*' --since '...' --until '...' \
     | grep -E 'ws\.slow_consumer\.killed|slow consumer: terminating' | grep USER
   ```

   - **Hit** → **connected but slow consumer killed** (`buffered` ≥ `WS_BACKPRESSURE_KILL_BYTES`, default 2 MiB).

3. **Send failed / frame dropped (non-message drop; message uses queue)?**

   ```bash
   journalctl -u 'chatapp@*' --since '...' --until '...' \
     | grep -E 'ws\.send_failed|ws\.slow_consumer\.frame_dropped' | grep USER
   ```

   - **`frame_dropped`** for non-`message:*` only; **`message:*`** is not dropped at the drop threshold, but **kill** still applies.

4. **Event-loop / queue pressure (this repo’s metrics)?**

   From Prometheus on the scrape window:

   - **`rate(ws_outbound_queue_block_waits_total[5m])` above zero** for the same minute → **`message:*` enqueues waited** because the per-socket queue stayed at cap (bounded wait with `setImmediate`) → classify as **connected but delivery path backlogged** (starvation / burst).
   - **`ws_outbound_queued_frames`** elevated across instances → backlog on process-wide outbound queues.

5. **Replay ran after reconnect?**

   ```bash
   journalctl -u 'chatapp@*' --since '...' --until '...' \
     | grep -E 'ws\.replay\.missed_messages|ws\.reconnected_after_gap' | grep USER
   ```

   - **`missed_messages`** after a gap → **disconnected** path recovered from DB.

### Decision table (within ~2 minutes)

| Evidence | Verdict |
|----------|---------|
| `SMEMBERS user:USER:connections` empty and no `dm_fanout_timing` slowness | **Not connected** (or harness/client never held WS open for `USER`). |
| Connections + `alive` = 1 near T, `dm_fanout_timing.totalMs` low, **`ws_outbound_queue_block_waits_total` / queued frames up** | **Connected but event-loop / outbound-queue starved** (mitigation: capacity, batch tuning `WS_OUTBOUND_DRAIN_BATCH`, shard spread). |
| **`ws.slow_consumer.killed`** for `USER` near T | **Connected but slow consumer killed**. |
| **`ws:recent_disconnect:USER`** set and **`ws.replay.missed_messages`** after | **Disconnected** then replay; if timeout still counted, harness window vs replay overlap. |

## After mitigation

Update the incident log, trigger a **staging drill** ([`deploy/staging-drill-checklist.md`](../deploy/staging-drill-checklist.md)), and open a follow-up if the root cause is uncaught by tests (see [`docs/verification-risk-register.md`](verification-risk-register.md)).
