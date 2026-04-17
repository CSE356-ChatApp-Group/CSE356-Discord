# Staging capacity testing

This folder contains a repeatable **staging-only** load test that ramps traffic until the system degrades and records artifacts for later analysis.

## What it exercises

- `POST /auth/login`
- `GET /api/v1/communities`
- `GET /api/v1/conversations`
- `GET /api/v1/messages?channelId=...`
- `PUT /api/v1/messages/:id/read`
- `POST /api/v1/messages`
- WebSocket presence/activity churn
- Optional WebSocket post-to-delivery probes after `POST /messages`:
  - **Channel probe:** client explicitly subscribes to `channel:<id>`.
  - **User-feed-only probe (grader-shaped):** peer opens WS with **no** `channel:` subscribe; must still receive `message:created` within 15s (canonical user-feed path).

## Run profiles

```bash
npm run load:staging:smoke
npm run load:staging:slo
npm run load:staging:tune
npm run load:staging:peak
npm run load:staging:break-fast
npm run load:staging:break
```

The `break` profile is intentionally aggressive and is meant to find the failure point.
Use `slo` for steady-state go/no-go checks, `tune` for fast iteration while changing knobs,
and `break-fast` when you want the stress envelope sooner.

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
- `LOADTEST_WS_MESSAGE_DELIVERY_PROBE=1`
- Mix tuning (all optional, auto-normalized):  
  `LOADTEST_MIX_COMMUNITIES`, `LOADTEST_MIX_CONVERSATIONS`, `LOADTEST_MIX_MESSAGES_LIST`,  
  `LOADTEST_MIX_CHANNELS`, `LOADTEST_MIX_MESSAGE_READ`, `LOADTEST_MIX_POST_CHANNEL`,  
  `LOADTEST_MIX_POST_CONVERSATION`, `LOADTEST_MIX_REAUTH`

## Important notes

- **Do not run this against production.**
- Expect staging alerts and noisy dashboards during the run.
- A non-zero exit code usually means the system hit the defined latency/error thresholds — that is useful capacity data, not necessarily a tooling bug.
- `slo` enables the WS delivery probe by default; other profiles can opt in with `LOADTEST_WS_MESSAGE_DELIVERY_PROBE=1`.
