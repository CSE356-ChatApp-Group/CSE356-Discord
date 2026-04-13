# Runbooks (ChatApp)

Short actions for alerts in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml). Replace hostnames with your environment.

## ChatAppSyntheticProbeFailed

Fires when the **host-local** synthetic probe (see [`scripts/synthetic-probe.sh`](../scripts/synthetic-probe.sh), `TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile`) reports **`chatapp_synthetic_probe_success == 0`** for 10 minutes. This is **not** the COMPAS harness; it is a curl to **`http://127.0.0.1/health`** through normal routing.

1. `curl -fsS -v http://127.0.0.1/health` on the VM.
2. `systemctl status 'chatapp@*'` and nginx `error.log` for upstream errors.
3. **`deploy-prod.sh`** installs `/opt/chatapp-monitoring/synthetic-probe.sh` and an **idempotent** crontab entry (every 2 minutes, `TEXTFILE_DIR=/opt/chatapp-monitoring/node_exporter_textfile`). If cron is missing, re-run a prod deploy or add that line manually for the deploy user.

## ChatAppTrafficCliffWhileInstancesUp

Fires when Prometheus still scrapes at least one `chatapp-api` target but **completed HTTP traffic** (from `http_server_requests_total`) is **below 20% of the rate 15 minutes ago**, and the prior rate was above **~40 req/s**. This is **not** a deploy signal by itself.

1. Confirm **no deploy** in the window: `journalctl -t chatapp-deploy --since '2026-04-13 14:00:00' --until '2026-04-13 15:00:00'` (adjust UTC).
2. **Compare ingress vs app:** on the VM, `zgrep` nginx `access.log` for **requests per minute** in the incident window — if edge volume collapsed, the bottleneck is **load generators / network path** to the site, not necessarily Node.
3. **5xx panels** can stay flat: if clients stop sending requests, you see a **traffic cliff** with **no** `ChatAppHigh5xxRate`.
4. Optional: run a probe **outside** the harness — [`scripts/synthetic-probe.sh`](../scripts/synthetic-probe.sh) against the public `/health`. If it stays green while Grafana RPS drops, the API process path is likely fine.

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
2. Ensure Node heap limits match VM size (2 GB VM → keep RSS well below OOM).

## WebSocket / fanout

If realtime is broken but REST is healthy:

1. Confirm nginx upgrades WebSocket (`Upgrade`, `Connection`) per deploy config.
2. Run [`deploy/candidate-ws-smoke.cjs`](../deploy/candidate-ws-smoke.cjs) against candidate URL if available.
3. Inspect fanout queue metrics and logs in [`backend/src/messages/sideEffects.ts`](../backend/src/messages/sideEffects.ts) paths.

## Grader-oriented delivery checks

**Course definitions** (15s per listener, outage windows): [`GRADING-DELIVERY-SEMANTICS.md`](GRADING-DELIVERY-SEMANTICS.md).

Automated graders (browser clients) should treat **HTTP as the source of truth** for whether a message exists, not the DOM immediately after `POST /messages` returns.

1. **Preferred:** After a successful write (`201`), call **`GET /messages?channelId=…` or `GET /messages?conversationId=…`** and assert the new message id or content appears on the first page. The API awaits Redis eviction of the first-page cache before responding on create/update/delete and on group invite/leave system rows; the web client also skips its short in-memory GET cache for `/messages` paths (see [`frontend/src/lib/api.ts`](../frontend/src/lib/api.ts)).
2. **If checking the UI only:** For **`POST /messages`** (`message:created`) and for **`PATCH` / `DELETE` on a message**, the server **awaits `fanout.publish`** before returning, so the UI can update immediately after success on those routes. **`read:updated`** and some other paths may still use the in-process fanout queue — for those, a **short wait** or **GET** assertion is safer than WS-only zero-wait.
3. **Do not** rely solely on WebSocket delivery for grading unless you accept occasional false negatives under normal load.

**Throughput harnesses:** channel **`message:created`** is duplicated to **`user:<member>`** by default so listeners receive it as soon as the **`user:`** Redis subscription is live (before full **`channel:`** bootstrap). See [`GRADING-DELIVERY-SEMANTICS.md`](GRADING-DELIVERY-SEMANTICS.md). Watch **`ws_bootstrap_wall_duration_ms`** if accounts have extreme community counts.

## Metrics during grader or load-test runs

When investigating **delivery fails**, **peak rate**, or tail latency under many concurrent browser sessions, correlate with:

| Metric | What it indicates |
|--------|-------------------|
| `side_effect_queue_depth{job="chatapp-api",queue="fanout:critical"}` | Backlog of Redis publish jobs for message/read fanout; sustained growth means realtime lag. |
| `side_effect_queue_delay_ms` (histogram) | Time from enqueue to running the fanout job; high p95 means delayed WS delivery after writes. |
| `ws_backpressure_events_total{job="chatapp-api"}` | Server dropped a frame or closed a socket because the client could not drain the WS buffer fast enough. |
| `ws_bootstrap_wall_duration_ms` | Wall time to finish auto-subscribe batches; very high values correlate with missed **`channel:`**-only delivery before **`user:`** duplicate existed or when fanout is disabled. |

Related alerts: [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) (for example critical fanout backlog and delivery degradation rules).

Grafana **ChatApp Overview** ([`infrastructure/monitoring/grafana-provisioning/dashboards/chatapp-overview.json`](../infrastructure/monitoring/grafana-provisioning/dashboards/chatapp-overview.json)) includes a **Grader / delivery debugging** section: WebSocket backpressure, `message_post_response_total`, fanout queue depth/delay, pool waiting, `/api/v1/messages` HTTP mix, overload stage, and client-aborted requests.

**Before release / after delivery changes:** run `cd backend && npm test` (full suite). For a staging grader-style load, compare **POST `/messages` p95/p99** (synchronous fanout adds latency) with **`ws_backpressure_events_total`** and fanout queue depth above.

## Harness outage — correlate a specific time window (minute-level)

COMPAS **outage** bands are often **short**. Repo-wide HTTP **5xx%** panels can stay flat while the harness reports **failed deliveries** (WS SLA), so triage needs **logs + journals** on the exact minutes.

1. Read start/end **UTC** from the harness chart (x-axis).
2. From a machine with SSH to prod:

   ```bash
   ./scripts/prod-harness-window.sh '2026-04-12 05:14:00' '2026-04-12 05:22:00'
   ./scripts/prod-harness-window.sh '2026-04-12 05:53:00' '2026-04-12 06:03:00'
   ```

   Optional: widen padding around deploys: `PADDING_MIN=3 ./scripts/prod-harness-window.sh '...' '...'`

   The script prints **`chatapp-deploy`** events, **`chatapp@` journal** (warning+), **nginx error.log** lines (upstream reset/refused/timeout), and an **access.log** status histogram for both a **padded** window and your **strict** harness interval (scans the last **ACCESS_TAIL_LINES** lines of access.log — increase if the window is old).

3. **Grafana / Prometheus** for the same UTC range: zoom the dashboard to the outage; check **event-loop lag p99**, **p95 latency**, **WS accepted rate**, **`http_server_requests_aborted_total`** (if panel exists), **fanout queue wait p95**. Harness failures without **5xx** usually show as **lag + aborts + reconnects**, not **ChatAppHigh5xxRate**.

4. Hour-granular nginx only: [`scripts/prod-log-correlate.sh`](../scripts/prod-log-correlate.sh) (POST `/messages` mix per clock hour).

### Example (prod `group-8`, 2026-04-12) — evidence already pulled

If Grafana shows **traffic drop ~14:35** and **p95 + event-loop spike ~15:55** (axis in **US/Eastern**), these **UTC** journal facts align:

- **`last -x reboot` / `shutdown`:** **18:27–18:28 UTC** — full VM stop/boot (**~14:27–14:28 EDT**).
- **`journalctl -u postgresql`:** **18:57:30–18:57:35 UTC** — PostgreSQL **restart** (**~14:57 EDT**); same minute as **`no live upstreams`** in **`/var/log/nginx/error.log`**.
- **Third band (~15:45–15:55 EDT → 19:45–19:55 UTC):** **no reboot**; **`journalctl` lines from `pgbouncer` (`stats:`)** show **`wait`** in the **multi‑second** range per minute bucket and **`xacts/s`** collapsing (e.g. **~1.1k/s → ~142/s** at **19:50 UTC**). **`grep` of nginx `error.log` for `19:4x` / `19:5x` returned 0** `[error]` lines in that prefix — not the same signature as the **14:57** upstream outage.
- **App logs in that window:** **`23503`** on **`channels_last_message_id_fkey`** from **`repointChannelLastMessage`** (logged at **error** before mitigation). Repo fix: **`repointLastMessage`** now **nulls `last_message_*` and returns** after exhausted FK retries so **`DELETE /messages` does not 500 after the row is already gone**.

**Repeatable snapshot on the VM:** `scripts/prod-capacity-snapshot.sh` (see repo; also validated in CI `bash -n`).

## After mitigation

Update the incident log, trigger a **staging drill** ([`deploy/STAGING-DRILL-CHECKLIST.md`](../deploy/STAGING-DRILL-CHECKLIST.md)), and open a follow-up if the root cause is uncaught by tests (see [`docs/VERIFICATION-RISK-REGISTER.md`](VERIFICATION-RISK-REGISTER.md)).
