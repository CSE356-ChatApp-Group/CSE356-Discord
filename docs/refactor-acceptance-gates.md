# Refactor acceptance gates

Use this checklist when landing structural refactors from the long-file refactor plan.

**Backend risk map (ranked hotspots + file links):** [`backend-hotspots.md`](backend-hotspots.md).

## API / behavior

- No unintended HTTP or WebSocket contract changes (unless called out in the PR).
- Existing backend integration tests and frontend unit tests pass (`npm test` at repo root).

## Deploy scripts

- `bash scripts/deploy/test-deploy-guards.sh` passes (SHA validation and shared `deploy-phase-common` wiring).
- No unintended change to remote mutation behavior: compare `--dry-run` output for orchestrators when touching deploy flow (`deploy/deploy-prod-multi.sh`).

## Observability

- Metrics names and labels unchanged unless the PR explicitly updates `backend/src/utils/metrics.ts` and ops docs.
- For throughput-sensitive routes, capture **before/after** Prometheus comparisons using [`operations-monitoring.md`](operations-monitoring.md#refactor--optimization-pr-comparison-prometheus).

## High blast radius (defer mechanical splits)

Treat these as **last-resort** edits: gate with integration coverage + staging metrics, typically **one behavioral knob per PR** with rollback noted.

| Module | Why defer | Gate before deeper refactors |
|--------|-----------|--------------------------------|
| [`backend/src/db/pool.ts`](../backend/src/db/pool.ts) | Circuit breaker + slow-query logging affect **every** DB call | Characterization or integration tests for breaker paths where feasible; staging snapshot: `pg_pool_waiting`, `pg_pool_circuit_breaker_rejects_total`, `http_server_request_duration_ms` by route |
| [`backend/src/messages/channelInsertConcurrency.ts`](../backend/src/messages/channelInsertConcurrency.ts) | Queue discipline + Redis lease + telemetry — ordering bugs → duplicates / 503 storms | Metrics on lock paths already emitted; correlate with `chatapp_overload_stage`, POST route latency; env split via [`channelInsertLockEnv.ts`](../backend/src/messages/channelInsertLockEnv.ts) |
| [`backend/src/utils/overload.ts`](../backend/src/utils/overload.ts) | Global shedding stages | Align with [`env.md`](env.md) tunables; compare `http_overload_shed_total`, `chatapp_overload_stage` |

**Allowed first steps:** extract **pure helpers** or **read-only telemetry** into separate files **without** changing call order or thresholds (same as production behavior).

## Where tests live

| Gate | Command |
|------|---------|
| Deploy guards | `bash scripts/deploy/test-deploy-guards.sh` |
| Backend characterization | `npm run test --workspace=backend -- tests/characterization/` |
| Full suite | `npm test` |
