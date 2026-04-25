# Canary: read receipt shedding (insert lock pressure) — **production VM3**

Conservative `PUT /api/v1/messages/:id/read` soft-defer under per-process channel insert-lock pressure (see [`env.md`](env.md): `READ_SHED_MESSAGE_INSERT_LOCK_*`, `MESSAGE_INSERT_LOCK_PRESSURE_WINDOW_MS`).

**Use production VM3 canary as the primary gate.** Staging has **not** reproduced prod insert-lock / read pressure reliably enough to trust it alone for this change.

## Prerequisites

- **SSH:** Run deploy from a host that can reach prod over SSH. Keys are usually for **`ubuntu@`** hosts; if your access is **`root@`**, set **`PROD_USER=root`** (and matching `MONITORING_VM_USER` if needed) when invoking `deploy-prod-multi.sh` / `deploy-prod.sh`. Phase -1 hits the **DB VM** (`PROD_DB_HOST`, default `130.245.136.21`); Phase 0 uses **`PROD_HOST`** VM3.
- **Release = GitHub SHA, not your working tree:** `deploy-prod-multi.sh` installs the artifact **`release-<sha>`** from GitHub Releases. **Commit, push, and wait for CI** to publish that asset before deploying. An uncommitted local tree is not what the script installs.

## Procedure (VM3 only → pause → observe)

1. **Preflight** — same as any prod multi deploy (`preflight-check`, artifact `release-<sha>`, DB migrations backward-compatible).
2. **Deploy VM3 only, then stop** — from repo root:

   ```bash
   DEPLOY_STOP_AFTER_VM3=1 ./deploy/deploy-prod-multi.sh <sha>
   ```

   This runs **Phase -1** (Postgres `max_connections` check), **Phase 0** (deploy `130.245.136.54` workers only), **Phase 0.5** (health on all six VM3 ports), then **exits** before VM2/VM1. VM1/nginx unchanged; traffic is still split across all 16 workers, so **~6/16** requests hit the new build.

3. **Pause rollout** — do **not** unset `DEPLOY_STOP_AFTER_VM3` or run the rest of the multi script until soak completes.

4. **Observe 10–15 minutes** — Prometheus (or `./scripts/metrics-snapshot.sh` from a host that can reach it).

5. **Compare `vm="vm3"` (treatment) vs `vm=~"vm1|vm2"` (control)** — same queries on both slices; control stays on the previous build during the canary.

6. **Resume full rollout** (if gates pass):

   ```bash
   ./deploy/deploy-prod-multi.sh <sha>
   ```

   This runs VM3 again (same sha, typically quick), then VM2, VM1, monitoring sync, etc.

## Hard gates (roll forward only if these pass)

| Gate | Requirement |
|------|-------------|
| **`POST /api/v1/messages` 503** | Rate **flat or lower** vs pre-canary baseline on **vm3** and fleet-wide; must **not** regress. Compare `rate(message_post_response_total{status_code="503"}[5m])` with `vm` label. |
| **Correctness smoke** | Passes: send message, mark read on low-pressure path (no unexpected 5xx). Optional: [`RUNBOOKS.md`](RUNBOOKS.md) grader watcher during soak. |

**`read_receipt_shed_total{reason="message_channel_insert_lock_pressure"}`** — if this stays **zero** during the soak, that is **not a failure**. It only means **insert-lock pressure did not hit the defer threshold** on the canary workers in that window. The important negatives are: no **503 regression** on POST, no correctness break, no surprise **`/read` 5xx** spike.

When pressure *does* appear, you should see non-zero defers on **vm3** (new build); vm1/vm2 will not increment that series until they run the new binary.

## PromQL (compare vm3 vs vm1|vm2)

Use **`[5m]`** during a 10–15m soak; widen to **`[15m]`** if the window is noisy.

**Deferrals (treatment signal when pressure exists):**

```promql
sum by (vm) (rate(read_receipt_shed_total{job="chatapp-api",reason="message_channel_insert_lock_pressure"}[5m]))
```

**POST 503 (primary gate):**

```promql
sum by (vm) (rate(message_post_response_total{job="chatapp-api",status_code="503"}[5m]))
```

**`/read` 5xx** (Node-completed only; route from [`backend/src/app.ts`](../backend/src/app.ts)):

```promql
sum by (vm, status_class) (
  rate(http_server_requests_total{
    job="chatapp-api",
    method="PUT",
    route="/api/v1/messages/:id/read",
    status_class="5xx"
  }[5m])
)
```

**POST latency (p95/p99):**

```promql
histogram_quantile(0.95, sum by (le, vm) (
  rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[5m])
))
histogram_quantile(0.99, sum by (le, vm) (
  rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}[5m])
))
```

**Insert lock timeouts / wait tail / pressure gauges:**

```promql
sum by (vm, result) (rate(message_channel_insert_lock_total{job="chatapp-api"}[5m]))
histogram_quantile(0.95, sum by (le, vm) (
  rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[5m])
))
histogram_quantile(0.99, sum by (le, vm) (
  rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}[5m])
))
message_channel_insert_lock_pressure_recent_timeout_count{job="chatapp-api"}
message_channel_insert_lock_pressure_wait_p95_ms{job="chatapp-api"}
```

Correlate nginx **502/504** in Loki if Node metrics look healthy but users report edge errors.

## Snapshot CLI

```bash
PROMETHEUS_URL='http://<prometheus-host>:9090' ./scripts/metrics-snapshot.sh --write var/metrics-snapshot.txt
```

[`scripts/metrics-snapshot.sh`](../scripts/metrics-snapshot.sh) includes several of the series above for paste-into-chat triage.

## Staging (optional)

[`./deploy/deploy-staging.sh <sha>`](../deploy/deploy-staging.sh) remains useful for **general** regression checks, but **do not** treat staging alone as sufficient for this feature: prod lock/read dynamics differ.

## Reference

- Orchestrator: [`deploy/deploy-prod-multi.sh`](../deploy/deploy-prod-multi.sh) (`DEPLOY_STOP_AFTER_VM3=1`)
- Hosts / scrape labels: [`infrastructure-inventory.md`](infrastructure-inventory.md)
- Metric names: [`backend/src/utils/metrics.ts`](../backend/src/utils/metrics.ts)
