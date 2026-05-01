# Refactor acceptance gates

Use this checklist when landing structural refactors from the long-file refactor plan.

## API / behavior

- No unintended HTTP or WebSocket contract changes (unless called out in the PR).
- Existing backend integration tests and frontend unit tests pass (`npm test` at repo root).

## Deploy scripts

- `bash scripts/deploy/test-deploy-guards.sh` passes (SHA validation and shared `deploy-phase-common` wiring).
- No unintended change to remote mutation behavior: compare `--dry-run` output for orchestrators when touching deploy flow (`deploy/deploy-prod-multi.sh`).

## Observability

- Metrics names and labels unchanged unless the PR explicitly updates `backend/src/utils/metrics.ts` and ops docs.

## Where tests live

| Gate | Command |
|------|---------|
| Deploy guards | `bash scripts/deploy/test-deploy-guards.sh` |
| Backend characterization | `npm run test --workspace=backend -- tests/characterization/` |
| Full suite | `npm test` |
