# Staging capacity testing

This folder contains a repeatable **staging-only** load test that ramps traffic until the system degrades and records artifacts for later analysis.

## What it exercises

- `POST /auth/login`
- `GET /api/v1/communities`
- `GET /api/v1/conversations`
- `GET /api/v1/messages?channelId=...`
- `POST /api/v1/messages`
- WebSocket presence/activity churn

## Run profiles

```bash
npm run load:staging:smoke
npm run load:staging:peak
npm run load:staging:break
```

The `break` profile is intentionally aggressive and is meant to find the failure point.

## Output artifacts

Each run writes to `artifacts/load-tests/<timestamp>/`:

- `summary.json` — k6 aggregate summary
- `metrics.ndjson` — raw k6 timeline data
- `prometheus-before.json` — staging metrics snapshot before load
- `prometheus-after.json` — staging metrics snapshot after load
- `report.md` — readable capacity summary
- `metadata.txt` — run configuration snapshot (profile, git SHA, overload/pool knobs)
- `app.log` — backend journal logs captured for the run window (best-effort)
- `app-errors.log` — filtered backend error lines used by the report (best-effort)

`report.md` includes **HTTP response shape** from k6: counts of status **0** (timeout / no TCP response), **503** (overload shed, PG pool circuit breaker, or nginx upstream), **4xx**, and **5xx** other than 503, plus Prometheus **`http_overload_shed_total`**, **`chatapp_overload_stage`**, **5xx peak rate during run**, and **top 5xx routes** when available. Use these to tell **fast 503** from **timeouts** and from **application 5xx**.
It also includes **top failing endpoints** from k6 tags, so you can prioritize fixes by route.

## Environment overrides

```bash
BASE_URL=http://136.114.103.71/api/v1 \
WS_URL=ws://136.114.103.71/ws \
STAGING_SSH_HOST=ssperrottet@136.114.103.71 \
npm run load:staging:break
```

Optional knobs:

- `LOAD_PROFILE=smoke|peak|break`
- `LOADTEST_PASSWORD=...`
- `MESSAGE_SIZE=128`
- `RUN_ID=my-custom-label`

## Important notes

- **Do not run this against production.**
- Expect staging alerts and noisy dashboards during the run.
- A non-zero exit code usually means the system hit the defined latency/error thresholds — that is useful capacity data, not necessarily a tooling bug.
