# Verification risk register

Living map: **scenario → automated tests → metrics/alerts → owner / N/A**.

| Risk area | Scenario | Tests | Metrics / alerts | Notes |
|-----------|----------|--------|------------------|-------|
| Message list cache | Stale first page after write or system DM row | [`backend/tests/messages.test.ts`](../backend/tests/messages.test.ts); [`frontend/e2e/dm-first-open-after-send.spec.ts`](../frontend/e2e/dm-first-open-after-send.spec.ts) | Redis TTL backstop only; prefer tests | POST/PATCH/DELETE bust keys; group system rows in [`conversationsRouter`](../backend/src/messages/conversationsRouter.ts) |
| Client GET dedupe | Stale REST within ~1.5s after navigation | [`frontend/src/stores/chatStore.test.ts`](../frontend/src/stores/chatStore.test.ts) | N/A | `invalidateApiCache` on `fetchMessages`, `fetchConversations`, `fetchCommunities`, `fetchChannels` |
| Idempotency | Duplicate POST /messages same key | [`backend/tests/messages.test.ts`](../backend/tests/messages.test.ts) (`POST /messages idempotency`) | N/A | `Idempotency-Key` + Redis |
| WebSocket delivery | Fanout, reconnect, subscribe races | [`backend/tests/websocket.test.ts`](../backend/tests/websocket.test.ts); API contract WS phases | `sideEffectQueue*`, fanout metrics if present | Queue drop = known tradeoff |
| Search | FTS lag vs expectations | [`backend/tests/search.test.ts`](../backend/tests/search.test.ts); [`frontend/e2e/search.spec.ts`](../frontend/e2e/search.spec.ts) | N/A | Postgres FTS; eventual for index |
| Auth / session | Register, login, refresh, OAuth | [`backend/tests/auth.test.ts`](../backend/tests/auth.test.ts); [`backend/tests/oauth-course-callback.test.ts`](../backend/tests/oauth-course-callback.test.ts); [`frontend/e2e/auth.spec.ts`](../frontend/e2e/auth.spec.ts) | `ChatAppFast5xxBurn`, login KPIs in k6 | Contract SSO when not skipped |
| Private channel ACL | Non-member read/subscribe | [`backend/tests/grader-parity.test.ts`](../backend/tests/grader-parity.test.ts); contract | N/A | `invalidateWsAclCache` on invite |
| Attachments | Presign, ACL | [`backend/tests/attachments.test.ts`](../backend/tests/attachments.test.ts); [`frontend/e2e/attachments.spec.ts`](../frontend/e2e/attachments.spec.ts) | N/A | MinIO / S3 URL signing |
| Overload | 503 sheds non-essential | [`backend/tests/messages.test.ts`](../backend/tests/messages.test.ts) | `http_overload_shed`, `ChatAppHigh5xxRate` | Document UX |
| Deploy / WS proxy | Nginx upgrade, health | [`deploy/candidate-ws-smoke.cjs`](../deploy/candidate-ws-smoke.cjs) (CI syntax); manual | `ChatAppApiDown`, `ChatAppProcessRestartFlapping` | |
| Load / SLO | Steady-state latency & KPIs | [`load-tests/staging-capacity.js`](../load-tests/staging-capacity.js); [`.github/workflows/staging-load-gate.yml`](../.github/workflows/staging-load-gate.yml) | k6 `optimization_*` counters | See [`docs/SLOS-AND-CHAOS.md`](SLOS-AND-CHAOS.md) |
| Ops response | On-call actions | N/A | [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) | [`docs/RUNBOOKS.md`](RUNBOOKS.md), [`deploy/STAGING-DRILL-CHECKLIST.md`](../deploy/STAGING-DRILL-CHECKLIST.md) |

**PR vs main:** [`ci-deploy`](../.github/workflows/ci-deploy.yml) runs Jest + Vitest. **Smoke E2E** runs on pull requests via [`pr-e2e-smoke.yml`](../.github/workflows/pr-e2e-smoke.yml) (Docker stack + Playwright `@smoke`). Staging/nightly still run full `@staging` E2E and API contract.

**Review:** Update this table when adding features or alerts.
