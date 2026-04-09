# Runbooks (ChatApp)

Short actions for alerts in [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml). Replace hostnames with your environment.

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

## ChatAppHighP95Latency

1. Check hot routes; inspect DB slow queries and Redis latency.
2. Compare with k6 `slo` summary from the same week.

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

## After mitigation

Update the incident log, trigger a **staging drill** ([`deploy/STAGING-DRILL-CHECKLIST.md`](../deploy/STAGING-DRILL-CHECKLIST.md)), and open a follow-up if the root cause is uncaught by tests (see [`docs/VERIFICATION-RISK-REGISTER.md`](VERIFICATION-RISK-REGISTER.md)).
