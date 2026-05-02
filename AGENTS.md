# Agents and contributors

Use this file as the **front door** before duplicating env profiles, IPs, or topology in issues, runbooks, or AI prompts. The full index, “do not duplicate” rules, and doc inventory live in [`docs/README.md`](docs/README.md) — this table is a short route into that map.

| Need | Start here |
|------|------------|
| **Where docs live and how to update them without drift** | [`docs/README.md`](docs/README.md) |
| **Prod/staging merged env (git-tracked)** | [`deploy/env/prod.required.env`](deploy/env/prod.required.env), [`deploy/env/staging.required.env`](deploy/env/staging.required.env) |
| **Variable semantics and defaults** | [`docs/env.md`](docs/env.md), [`.env.example`](.env.example) |
| **Hosts, SSH users, sizing** | [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md) (canonical; update when infra changes) |
| **Metrics, PromQL, snapshots** | [`docs/operations-monitoring.md`](docs/operations-monitoring.md) — names also in `backend/src/utils/metrics.ts` |
| **Redis keys / fanout topic patterns** | [`docs/redis-key-map.md`](docs/redis-key-map.md) |
| **Incidents and alerts** | [`docs/runbooks.md`](docs/runbooks.md), [`infrastructure/monitoring/alerts.yml`](infrastructure/monitoring/alerts.yml) |
| **End-to-end diagnosis + improvement loop** | [`docs/agent-operations-playbook.md`](docs/agent-operations-playbook.md) |
| **Cursor / workspace rules** | [`.cursor/rules/`](.cursor/rules/) |
| **Copilot / short AI context** | [`.github/copilot-instructions.md`](.github/copilot-instructions.md) |
| **Running tests** | From **repo root**: `npm test` — runs backend Jest (`backend` workspace) then frontend Vitest. Backend only: `npm test --workspace=backend`. Raw Jest (no test-runner wrapper): `cd backend && npm run test:raw -- <jest-args>`. Postgres/Redis integration suites: prefer `npm run test:docker --workspace=backend` or `TEST_FORCE_PROVISION=1` with `env -u DATABASE_URL` per suite headers in `backend/tests/`. |

## Agent traversal protocol (fast path)

1. Start at [`docs/README.md`](docs/README.md) to classify doc type (**operational**, **playbook**, **design/history**).
2. For behavior questions, verify against code paths listed in `docs/README.md` before editing prose.
3. For env/topology claims, confirm against [`deploy/env/*.required.env`](deploy/env/) and [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md).
4. Prefer updating one canonical doc and linking to it; avoid copying full env blocks or host tables.
5. Ignore generated benchmark notes under `artifacts/` unless the task explicitly asks for historical run output.

**Conflict resolution:** If prose disagrees with **code** or **git-tracked `deploy/env/*.required.env`**, treat the latter as truth and fix the doc.
