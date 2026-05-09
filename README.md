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
| Postgres pool/query pressure | Prometheus route p95/p99, `pg_pool_waiting`, query counts per request, `pg_stat_statements`, and load-test status mixes. | Added read-replica routing, reduced query round trips, tuned pool/overload behavior, added route-specific diagnostics, and optimized hot message/conversation paths. | Fewer synchronous DB calls per request and better separation of read load from primary writes. | Strong reads may still need primary routing; replica reads can lag briefly. |
| Message and WebSocket fanout | Delivery failures, WebSocket metrics, Redis fanout counters, generated-client behavior, and grader 15s delivery semantics. | Standardized channel/conversation/user topic fanout, sharded logical user delivery, strict WebSocket `ready`, pending replay, queue/backpressure metrics, and Redis Pub/Sub delivery maps. | Any API worker can accept a message while every worker can deliver it to its local sockets through Redis. | Duplicate fanout improves compatibility but increases Redis work for large audiences. |
| Cache invalidation keeping hit rates near zero | `endpoint_list_cache_total`, cache invalidation counters, route p99 spikes, and production p99 analysis. | Reduced per-message structural cache invalidation, added cache guardrails, tuned list/cache TTLs, and documented Redis key families. | Hot list routes can reuse cached responses instead of repeatedly running expensive DB queries. | Caches must be invalidated carefully on membership or structural changes. |
| Search tail latency | Search route p95/p99, Meili/OpenSearch latency breakdowns, fallback counters, and Postgres recheck metrics. | Added dedicated search backend paths behind flags, bounded candidate/recheck work, tuned fallback behavior, and preserved Postgres fallback for correctness. | Search no longer amplifies tail latency by repeatedly falling through unbounded fallback paths. | Dedicated search infrastructure adds indexing lag and operational complexity. |
| Production rollout risk | Failed deploy attempts, fleet version skew, nginx/WebSocket drain behavior, and release artifact integrity checks. | Added manual production canaries, build-SHA verification, safer rollback/deploy locks, nginx drain handling, monitoring sync, and fleet SHA metrics. | Rollouts can prove one VM before fleet-wide deployment and can verify that all workers run the intended release. | Staging may be unavailable, so production canaries and monitoring must be used carefully. |

Load testing:

- `npm run load:staging:smoke`, `npm run load:staging:slo`, `npm run load:staging:break`, and related profiles exercise auth, community/conversation/message reads, message posts, read receipts, and WebSocket churn.
- Each run records k6 summaries, Prometheus snapshots, logs, metadata, and a report under `artifacts/load-tests/<timestamp>/`.
- Status `0`, `503`, `5xx`, p95/p99 latency, Postgres pool pressure, Redis fanout delay, event loop lag, and WebSocket delivery are analyzed together instead of treating one metric as the whole story.

The result is not just "more servers"; the system uses measured route-level and infrastructure evidence to decide whether to optimize SQL, cache behavior, Redis fanout, search fallback, worker layout, or deployment capacity.

## Design Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Durable data store | Postgres with UUID keys, migrations, and optional read-replica routing. | Relational constraints fit users, memberships, channels, messages, and read state; replicas provide a path for read scaling. |
| Realtime transport | WebSockets on every API worker with Redis Pub/Sub as the shared bus. | Workers stay horizontally scalable while Redis bridges events across processes and hosts. |
| Delivery compatibility | Publish message events to message-bearing channel/conversation topics and logical user streams where needed. | Rich clients can subscribe to precise topics, while generated or reconnecting clients still receive compatible `message:created` events. |
| Caching | Redis list caches, idempotency leases, presence TTLs, fanout target caches, and key maps. | Redis absorbs repeated reads and short-lived coordination without making the backend stateful. |
| Backpressure and overload | Pool guards, overload stages, fanout queues, timeout metrics, and shedding where safer than hanging. | Under load, fast failure and clear metrics are easier to debug than unbounded queues. |
| Search | Postgres full-text search plus optional Meili/OpenSearch paths with bounded fallback and recheck. | Postgres is the correctness baseline; dedicated search can improve latency/scale when carefully bounded. |
| Deployment | Immutable release artifacts, manual production canary, multi-VM rollout, build-SHA checks, and rollback scripts. | Reduces version skew and lets risky backend changes soak before full cutover. |
| Observability | Prometheus metrics, Grafana dashboards, Loki logs, Tempo traces, Alertmanager alerts, request IDs, and runbooks. | Scaling decisions and incidents need concrete evidence, not guesswork. |
| Authentication/security | JWT-based protected API, OAuth/local auth support, token revocation paths, private object storage through pre-signed URLs. | Keeps API calls stateless while avoiding public attachment buckets. |

## Developer Guide

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
