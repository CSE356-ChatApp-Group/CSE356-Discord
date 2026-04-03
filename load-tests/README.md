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
