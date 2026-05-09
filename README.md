# ChatApp MVP

ChatApp is a Discord-like messaging system with communities, channels, direct messages, presence, search, attachments, and real-time WebSocket delivery. This README is the main final-project documentation entrypoint for a new developer or grader. Deeper operational references live in [`docs/README.md`](docs/README.md).

## Project Overview

The main purpose of the system is to provide a production-style messaging server that accepts HTTP API traffic, stores durable chat state in Postgres, and pushes real-time events to connected clients over WebSockets. The frontend talks to the backend through Nginx using REST endpoints for durable actions and a WebSocket connection for live updates.

Major components:

| Component | Role |
|-----------|------|
| Frontend client | Browser UI for auth, communities, channels, DMs, presence, search, and attachments. |
| Nginx | Reverse proxy, TLS entrypoint in production, and load balancer for API/WebSocket workers. |
| Backend API workers | Node/Express HTTP API plus WebSocket server. Multiple workers can run across VMs. |
| Postgres | Durable source of truth for users, communities, channels, messages, read state, and metadata. |
| Redis | Pub/Sub bus for realtime fanout, cache store, presence TTLs, idempotency leases, and coordination. |
| MinIO/S3-compatible storage | Attachment object storage through pre-signed URLs. |
| Monitoring stack | Prometheus, Grafana, Loki, Tempo, Alertmanager, and node exporters for operations and load analysis. |

Architecture:

```text
Browser / Mobile Client
        |
        | HTTP / WebSocket
        v
Nginx reverse proxy / load balancer
        |
        +-------------------+-------------------+
        |                   |                   |
        v                   v                   v
API + WS worker       API + WS worker      API + WS worker
        \                   |                   /
         \                  | Redis Pub/Sub    /
          +-----------------v-----------------+
                            |
                            v
                         Postgres
```

When a user posts a message, the backend validates access, inserts the message in Postgres, publishes a `message:created` event through Redis, and every API worker with matching local WebSocket clients forwards that event. The delivery contract and course-grading interpretation are documented in [`docs/architecture/realtime-delivery-contract.md`](docs/architecture/realtime-delivery-contract.md) and [`docs/architecture/grading-delivery-semantics.md`](docs/architecture/grading-delivery-semantics.md).

## Running the System

Required local dependencies:

- Docker and Docker Compose for the full local stack.
- Node.js and npm for direct development, tests, and builds.
- Optional: `k6` for load tests, `gh` for release/deploy workflows, and `promtool`/Ansible tooling for deploy-script validation.

Configuration:

- Start from [`.env.example`](.env.example): `cp .env.example .env`.
- Full variable semantics live in [`docs/env.md`](docs/env.md).
- Git-tracked staging and production required profiles live in [`deploy/env/staging.required.env`](deploy/env/staging.required.env) and [`deploy/env/prod.required.env`](deploy/env/prod.required.env).
- Current host topology, SSH users, and sizing live in [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md).

Quick start:

```bash
git clone https://github.com/CSE356-ChatApp-Group/CSE356-Discord.git chatapp
cd chatapp
cp .env.example .env
docker compose up -d
curl http://localhost/health
```

Local service URLs after startup:

| Service | URL | Notes |
|---------|-----|-------|
| API | `http://localhost/api/v1` | Routed through Nginx. |
| WebSocket | `ws://localhost/ws` | Pass `token=<accessToken>` after login. |
| MinIO console | `http://localhost:9001` | S3-compatible object storage UI. |
| Grafana | `http://localhost:3001` | Default local credentials are `admin` / `admin`. |
| Prometheus | `http://127.0.0.1:9090` | Metrics and PromQL. |
| Alertmanager | `http://localhost:9093` | Local alert routing. |

Common commands:

```bash
docker compose up -d       # start local stack
docker compose logs -f api nginx
docker compose down        # stop local stack

npm test                   # backend Jest, then frontend Vitest
npm run build              # build backend and frontend
npm run docs:check         # documentation consistency checks
```

Targeted tests:

```bash
npm --prefix backend run test
npm --prefix backend run test:docker
npm --prefix frontend run test
```

If no `DATABASE_URL` is provided, the backend test runner provisions disposable Postgres and Redis containers for Jest. If `DATABASE_URL` is set manually, the runner refuses unsafe non-test databases unless explicitly overridden.

Deployment:

- CI builds and tests backend/frontend and packages immutable release artifacts.
- Production deploys are manual and use canary rollout steps; see [`deploy/README.md`](deploy/README.md).
- The course production layout is multi-VM and environment-specific. Do not copy IPs or env blocks from this README; use [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md) and `deploy/env/*.required.env`.

Cloud assumptions:

- Production expects reachable Postgres, Redis, object storage, and monitoring endpoints.
- App workers are intended to be stateless aside from local WebSocket connections; shared state is in Postgres and Redis.
- WebSocket clients must tolerate reconnects and resubscribe/rehydrate after `ready`.

## Scaling and Load Handling

The scaling work focused on finding the actual bottleneck under load, measuring it, and then changing either the data path or deployment topology. Evidence is spread across [`load-tests/README.md`](load-tests/README.md), [`docs/p99-spike-analysis.md`](docs/p99-spike-analysis.md), [`docs/route-performance-audit.md`](docs/route-performance-audit.md), [`docs/operations-monitoring.md`](docs/operations-monitoring.md), and generated reports under `artifacts/load-tests/`.

Main bottlenecks identified:

| Bottleneck | Evidence used | Changes made | Why it helped | Remaining tradeoff |
|------------|---------------|--------------|---------------|--------------------|
| Expensive read routes and Postgres variance | Production route snapshots showed `GET /conversations` at p95 479 ms / p99 2905 ms with 8 PG queries, `GET /search` at p95 235 ms / p99 1105 ms, and `POST /messages` around 68.6 req/s with p95 46 ms / p99 171 ms. Pool metrics at that time showed 0 waiting / 6 idle / 6 total, so the problem was query shape and variance, not simple pool starvation. | Reduced query round trips on hot routes, removed or avoided expensive sidebar work, added read-replica routing for message reads, added route-specific latency diagnostics, and used `pg_stat_statements` snapshots to identify expensive normalized SQL. | The fixes focused effort on routes where p99 actually moved, instead of increasing pool sizes blindly. Fewer synchronous DB operations per request reduced tail amplification under concurrent writes. | Strong consistency still needs primary reads in some cases; replica reads can briefly lag and complex relational queries still need ongoing profiling. |
| List caches that were never warm | [`docs/p99-spike-analysis.md`](docs/p99-spike-analysis.md) recorded 0.0000/s hit rates for channel/community/conversation/message list caches during a production window. At roughly 68 messages/s, per-message invalidation could delete participant caches 136-340 times/s, faster than clients could reuse them. | Stopped treating ordinary message fanout as a structural list invalidation, added explicit invalidation reasons, cache guardrail metrics, Redis key documentation, and cache comparison scripts. | Hot list endpoints can now serve cached data between real structural changes such as joins, leaves, new conversations, or channel edits. This directly targets routes like `GET /conversations` and `GET /channels`, where cache misses forced expensive DB work. | Cache correctness depends on disciplined invalidation. The team kept Redis key maps and cache metrics documented so stale or over-broad invalidation can be caught. |
| Realtime delivery across multiple workers | Course delivery checks count every listener that should receive `message:created` within about 15 seconds. Failures were debugged with WebSocket readiness, Redis publish/fanout counters, outbound queue/backpressure metrics, pending replay metrics, and generated-client parity tests. | Kept API/WS workers horizontally scalable by using Redis Pub/Sub; published channel and conversation events to message-bearing topics; added logical `user:<id>` delivery where needed; introduced sharded user-feed delivery; made WebSocket `ready` stricter; and added pending replay for reconnecting clients. | A message can be accepted by any worker and delivered by every worker that has relevant local sockets. The user-topic compatibility path also protects generated or reconnecting clients that do not subscribe like the full frontend. | Duplicate compatibility fanout increases Redis work for large audiences, so large channels require fanout target caching, sharding, and backpressure monitoring. |
| Search migration: Postgres FTS -> Meilisearch -> OpenSearch | Search started on Postgres FTS, moved to Meilisearch candidate retrieval when FTS became too expensive, then moved production reads to OpenSearch candidates after Meili showed tail-latency and operational limits. Evidence included `GET /search` p95 235 ms / p99 1105 ms, Meili p99 around 350 ms, Postgres recheck p99 around 192 ms, freshness rescue p99 around 380-471 ms, and fallback reasons such as empty candidates, strict token mismatch, recheck errors, and unavailable search backend. | Kept Postgres as the response/correctness authority, introduced Meilisearch as an external candidate layer, then added OpenSearch candidate retrieval behind flags with bounded candidate counts, dual-write/backfill support, read toggles, and explicit fallback/recheck metrics. Production now uses `SEARCH_BACKEND=opensearch` with Postgres recheck; staging can still default to Postgres for safety. | Search could move expensive candidate generation off the primary relational database while preserving permissions, deleted-message filtering, edit freshness, author/time filters, and response shape through Postgres recheck. OpenSearch also gave a more scalable candidate backend than the Meili path under our workload. | The search stack is more complex: OpenSearch indexing/backfill and dual-write must be monitored, Meili remains rollback/legacy infrastructure, and Postgres fallback/recheck still needs bounds to avoid turning search misses into DB spikes. |
| Deployment and rollout risk under active tuning | Production performance work caused frequent regressions from cross-cutting side effects. Evidence came from deploy failures, fleet version skew, nginx/WebSocket drain behavior, build-artifact mismatches, and route/host metrics after rollout. | Used immutable release artifacts, embedded build SHA checks, fleet-wide `chatapp_build_info`, deploy locks, rollback scripts, nginx drain handling, manual production canaries, VM-first rollout, and monitoring sync. | Risky backend changes could be proven on one VM before full rollout, and the team could verify which SHA every worker was running. | Staging availability changed over time, so production canaries and monitoring became more important than ideal. |

Load testing:

- `npm run load:staging:smoke`, `npm run load:staging:slo`, `npm run load:staging:break`, and related profiles exercise auth, community/conversation/message reads, message posts, read receipts, and WebSocket churn.
- Each run records k6 summaries, Prometheus snapshots, logs, metadata, and a report under `artifacts/load-tests/<timestamp>/`.
- Status `0`, `503`, `5xx`, p95/p99 latency, Postgres pool pressure, Redis fanout delay, event loop lag, and WebSocket delivery are analyzed together instead of treating one metric as the whole story.

The result is not just "more servers"; the team used route-level latency, status-code mix, cache hit ratios, Redis fanout metrics, Postgres fingerprints, and rollout telemetry to decide whether a problem called for SQL work, cache changes, Redis fanout changes, search fallback bounds, worker layout changes, or more capacity.

## Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Durable data store | Postgres with migrations, UUID primary keys, relational membership tables, message/read-state tables, and optional read-replica routing for heavy message reads. | The core data has strong relationships and access-control checks. Postgres gives constraints and transactional writes, while replicas help with read-heavy endpoints when the UI can tolerate brief lag or explicitly request primary consistency. |
| Realtime transport | WebSockets run inside every API worker, and Redis Pub/Sub carries events between workers and hosts. | WebSocket connections are local to a process, but messages can be posted to any worker. Redis lets every worker observe the same event stream and deliver only to sockets it owns. |
| Message delivery design | Channel messages publish to `channel:<id>` and, where compatibility requires it, logical user streams; DM/group messages publish to `conversation:<id>` and participant user streams. | Topic-specific delivery is efficient for hydrated clients, while user-stream delivery protects generated clients, reconnecting clients, and clients waiting for subscription bootstrap. |
| Redis strategy | Redis is used for Pub/Sub fanout, presence TTLs, idempotency leases, list caches, fanout target caches, pending replay markers, and short-lived coordination. | These are latency-sensitive and ephemeral concerns that should not make API workers stateful or force extra Postgres writes on every request. |
| Cache invalidation policy | Ordinary message sends should not invalidate every structural list cache; structural changes such as membership, channel, or conversation changes own those invalidations. | Per-message invalidation kept caches at 0% hit rate under load. Separating message events from structural changes lets list caches actually reduce DB work. |
| Backpressure and overload | Use pool guards, overload stages, fanout queues, timeout metrics, and explicit shedding instead of allowing unbounded request or delivery queues. | Under overload, clear 503s and metrics are easier to recover from than slow cascading timeouts that obscure the bottleneck. |
| Search architecture | Search evolved from Postgres FTS to Meilisearch candidates to OpenSearch candidates. Production search reads use OpenSearch for candidate IDs, then Postgres rechecks permissions, deletion/edit state, filters, and response formatting. | External search engines reduce candidate-generation load, but only Postgres has the authoritative relational context for channel privacy and latest message state. Keeping Postgres recheck stable let the team change search engines without changing the API contract. |
| Deployment strategy | Build immutable release tarballs, verify embedded build SHAs, deploy manually, canary one VM first for risky changes, then roll out the fleet with rollback available. | Most serious regressions were cross-system effects. Canary deploys and fleet SHA proof reduce the chance of silently running mixed or stale builds. |
| Observability | Prometheus metrics, Grafana dashboards, Loki logs, Tempo traces, request IDs, Alertmanager rules, load-test reports, and runbooks are part of the system design. | The team repeatedly needed evidence to distinguish DB, Redis, WebSocket, search, app CPU, and deployment causes. Observability was necessary for scaling, not just operations polish. |
| Authentication/security | Use JWT-protected APIs with local/OAuth login support, token revocation paths, role checks, private object storage, and pre-signed attachment URLs. | This keeps protected API calls mostly stateless while avoiding public attachment buckets and preserving room for production reverse-proxy/TLS controls. |

## Developer Guide

First-day onboarding path:

1. Read this README once for the project shape, then skim [`docs/README.md`](docs/README.md) to understand which docs are canonical.
2. Start the local stack with `docker compose up -d` and verify `curl http://localhost/health`.
3. Run `npm test` from the repo root before making changes, so you know whether your environment is healthy.
4. Pick the subsystem you are changing from the map below and open its route/service/tests together.
5. For behavior changes, add or update a focused test first; for performance changes, capture the relevant metrics or load-test evidence before and after.
6. Before opening a PR or handing off work, run targeted tests plus `npm run docs:check` if any docs, env vars, metrics, or topology claims changed.

Repository structure:

```text
backend/                 Express API, WebSocket server, DB/Redis/search code, Jest tests
frontend/                Browser client and frontend tests
migrations/              Postgres schema migrations
infrastructure/          Nginx and monitoring configuration
deploy/                  Release, env profile, and production/staging deploy scripts
load-tests/              k6 staging load profiles and capacity test docs
scripts/                 Metrics, release, Redis, Postgres, load, and ops helpers
docs/                    Canonical docs index, env, topology, operations, architecture, history
artifacts/load-tests/    Generated historical load-test summaries
```

Important starting points:

- Docs map and maintenance rules: [`docs/README.md`](docs/README.md)
- Env semantics: [`docs/env.md`](docs/env.md)
- Infrastructure inventory: [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md)
- Metrics and PromQL: [`docs/operations-monitoring.md`](docs/operations-monitoring.md)
- Redis keys and Pub/Sub patterns: [`docs/redis-key-map.md`](docs/redis-key-map.md)
- Incident runbooks: [`docs/runbooks.md`](docs/runbooks.md)
- Backend hotspots: [`docs/backend-hotspots.md`](docs/backend-hotspots.md)

Common areas to start editing:

| Task | Start in code | Check docs/tests |
|------|---------------|------------------|
| Auth or user profile behavior | `backend/src/auth/`, `backend/src/auth/usersRouter.ts` | `backend/tests/`, API reference in this README |
| Channel or community APIs | `backend/src/channels/`, `backend/src/communities/` | `backend/tests/`, cache/env docs if list behavior changes |
| Message history or posting | `backend/src/messages/routes/`, `backend/src/messages/fanout/` | [`docs/architecture/realtime-delivery-contract.md`](docs/architecture/realtime-delivery-contract.md), message/read tests |
| WebSocket delivery | `backend/src/websocket/`, `backend/src/messages/fanout/` | [`docs/architecture/grading-delivery-semantics.md`](docs/architecture/grading-delivery-semantics.md), WebSocket tests |
| Search | `backend/src/search/` | [`docs/search-opensearch-migration.md`](docs/search-opensearch-migration.md), [`docs/env.md`](docs/env.md), search tests |
| Frontend UI | `frontend/src/` | `frontend/README.md`, frontend unit/e2e tests |
| Deploy or production config | `deploy/`, `.github/workflows/`, `deploy/env/` | [`deploy/README.md`](deploy/README.md), [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md) |
| Metrics or alerts | `backend/src/utils/metrics.ts`, `infrastructure/monitoring/` | [`docs/operations-monitoring.md`](docs/operations-monitoring.md), [`docs/runbooks.md`](docs/runbooks.md) |

How to add or modify a feature:

1. Find the relevant backend route, service, or frontend screen from the structure above.
2. Check [`docs/README.md`](docs/README.md) for the canonical doc that owns the behavior, env variable, metric, or topology claim.
3. Add or update tests near the changed behavior. Backend tests live in `backend/tests/`; frontend tests live under `frontend/` and `frontend/e2e/`.
4. If the change adds an env var, update [`.env.example`](.env.example), [`docs/env.md`](docs/env.md), and required deploy profiles if production/staging must pin it.
5. If the change adds a metric, define it in `backend/src/utils/metrics.ts` or the existing metrics modules and document operator-facing usage in [`docs/operations-monitoring.md`](docs/operations-monitoring.md).
6. Run targeted tests, then `npm test`, `npm run build`, and `npm run docs:check` when docs changed.

Debugging common problems:

| Problem | First checks |
|---------|--------------|
| API errors or latency | `docker compose logs -f api nginx`, request ID logs, Grafana route p95/p99, [`docs/runbooks.md`](docs/runbooks.md). |
| WebSocket delivery miss | Verify HTTP status, WebSocket `ready`, `message:created`, Redis fanout metrics, and [`docs/architecture/grading-delivery-semantics.md`](docs/architecture/grading-delivery-semantics.md). |
| Database pressure | `pg_pool_waiting`, route query counts, `pg_stat_statements`, and [`scripts/postgres/pg-stat-statements-snapshot.sh`](scripts/postgres/pg-stat-statements-snapshot.sh). |
| Cache behavior | `endpoint_list_cache_total`, invalidation counters, Redis key map, and cache guardrail snapshots. |
| Search tail latency | Search backend metrics, fallback counters, candidate/recheck timing, and [`docs/p99-spike-analysis.md`](docs/p99-spike-analysis.md). |
| Deployment issue | Release build SHA, deploy lock, nginx upstreams, fleet SHA metric, and [`deploy/README.md`](deploy/README.md). |

Known issues and future improvements:

- Some team contribution details are still placeholders in [`TEAM.md`](TEAM.md).
- Search can continue moving toward a dedicated backend once indexing and fallback behavior are stable.
- Very large channels still require careful fanout and Redis capacity planning.
- Read replicas improve read throughput but introduce possible short replication lag.
- Staging availability has changed over time; production canaries currently carry more validation responsibility.
- Future product features such as reactions, threads, polls, and voice channels can extend the existing message and realtime patterns.

### API Reference

All protected endpoints require `Authorization: Bearer <accessToken>`.

Authentication:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | No | Local registration. |
| `POST` | `/auth/login` | No | Local login. |
| `POST` | `/auth/refresh` | No | Refresh access token. |
| `POST` | `/auth/logout` | Yes | Revoke tokens. |
| `GET` | `/auth/google` | No | Start Google OAuth. |
| `GET` | `/auth/github` | No | Start GitHub OAuth. |

Messages:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/messages` | Paginated history by `channelId` or `conversationId`; supports `before`, `after`, and cached latest pages. |
| `GET` | `/messages/context/:messageId` | Search jump/context window around a message. |
| `POST` | `/messages` | Send a message; supports `Idempotency-Key` for safe retries. |
| `PATCH` | `/messages/:id` | Edit own message. |
| `DELETE` | `/messages/:id` | Delete own message. |
| `PUT` | `/messages/:id/read` | Update read cursor. |

Communities:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/communities` | Visible communities; supports keyset pagination with `limit` and `after`. |

WebSocket:

```json
{ "type": "subscribe", "channel": "channel:<uuid>" }
{ "type": "unsubscribe", "channel": "channel:<uuid>" }
{ "type": "presence", "status": "idle" }
{ "type": "activity" }
{ "type": "ping" }
```

Common server events include `ready`, `message:created`, `message:updated`, `message:deleted`, `presence:updated`, read receipt events, and membership/invite events. The exact delivery contract is in [`docs/architecture/realtime-delivery-contract.md`](docs/architecture/realtime-delivery-contract.md).

Search:

```text
GET /search?q=hello&communityId=<uuid>&authorId=<uuid>&after=2024-01-01&limit=20
```

## Team Process and Contributions

Team reflection and individual contributions are documented in [`TEAM.md`](TEAM.md). Samuel Perrottet's section is filled from repository history; the other team members are intentionally left as placeholders for final team review.

## Security Checklist

- Rotate all secrets in `.env` before production.
- Keep Redis and Postgres on private networks or firewalled ports.
- Set `NODE_ENV=production` for production workers.
- Keep object storage buckets private and use pre-signed URLs.
- Use TLS at the Nginx edge in production.
- Keep logging redaction enabled for tokens, cookies, and passwords.
- Monitor alerts from [`infrastructure/monitoring/alerts.yml`](infrastructure/monitoring/alerts.yml).
