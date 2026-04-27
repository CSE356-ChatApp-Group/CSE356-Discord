# ChatApp MVP

A production-ready messaging platform designed for cloud-native deployment.
Supports real-time messaging, communities, channels, DMs, presence, search, and attachments.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Browser / Mobile Client                        │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP/WebSocket
                    ┌────────▼────────┐
                    │  Nginx (Node 2) │  ← TLS termination, load balancing
                    └────────┬────────┘
          ┌─────────────────┼────────────────┐
   ┌──────▼──────┐   ┌──────▼──────┐  ┌──────▼──────┐
   │ API  Node 2 │   │ API  Node 3 │  │ API  Node 4 │
   │ (primary)   │   │ + Search    │  │ + Monitoring│
   └──────┬──────┘   └──────┬──────┘  └──────┬──────┘
          └──────────────────┼────────────────┘
                     ┌───────▼───────┐
                     │  Redis Pub/Sub│  ← WS fanout, presence, cache
                     └───────┬───────┘
                     ┌───────▼───────┐
                     │   Postgres    │  ← relational data (Node 1)
                     └───────────────┘
```

### Redis Pub/Sub Fanout

When a message is created on any API node:
1. The handler inserts the row into Postgres
2. Calls `fanout.publish(channel, event)` → publishes to Redis
3. All 3 API nodes receive it via their dedicated subscriber connection
4. Each node delivers it to its locally-connected WebSocket clients

This means *any* client connected to *any* node receives real-time events instantly.

**Course grading / throughput (“Failed deliveries”, outages):** see [`docs/GRADING-DELIVERY-SEMANTICS.md`](docs/GRADING-DELIVERY-SEMANTICS.md) for how the 15s-per-listener rule maps to HTTP 201, WebSocket `message:created`, and common false positives (403, harness scope).

---

## Quick Start (Local)

```bash
# 1. Clone and configure
git clone https://github.com/your-org/chatapp.git
cd chatapp
cp .env.example .env          # edit secrets as needed

# 2. Start all services
docker compose up -d

# 3. Verify
curl http://localhost/health   # → {"status":"ok"}
```

## Observability & Production Debugging

When something breaks in production, start here:

### Where to see logs

- **Fastest path:** `docker compose logs -f api nginx`
- **Grafana logs UI:** `http://localhost:3001` → **Explore** → select **Loki**
- Logs now include a **request ID** (`x-request-id`) so you can trace one failing request end-to-end.

### Where to see metrics and traces

- **Health check:** `http://localhost/health`
- **Prometheus metrics:** `http://localhost/metrics`
- **Grafana traces:** `http://localhost:3001` → **Explore** → select **Tempo**
- **Grafana dashboard:** `http://localhost:3001` → **Dashboards** → **ChatApp** → **ChatApp Overview**
- **Alertmanager UI:** `http://localhost:9093`
- **Prometheus UI:** `http://127.0.0.1:9090`
- **Loki API:** `http://127.0.0.1:3100`
- **Tempo API / metrics:** `http://127.0.0.1:3200`
- **Remote browser access:**
  - Staging Grafana: `http://136.114.103.71/grafana/`
  - Production Grafana: `https://group-8.cse356.compas.cs.stonybrook.edu/grafana/`
- **Prometheus alerts:** check `ChatAppApiDown`, `ChatAppHigh5xxRate`, `ChatAppHighP95Latency`, `ChatAppEventLoopLagHigh`, `ChatAppHighMemoryUsage`, `ChatAppCpuSaturationHigh`, `ChatAppPgPoolPressure`, `ChatAppOverloadSheddingActive`, `ChatAppHostCpuHigh`, `ChatAppHostMemoryPressure`, `ChatAppHostSwapIoHigh`, `ChatAppDiskSpaceLow`, and `ChatAppMinioDown`.

### Monitoring quick commands

```bash
npm run monitoring:up       # start / refresh Grafana, Prometheus, Loki, Tempo, etc.
npm run monitoring:status   # one-screen health summary + URLs
npm run monitoring:logs     # tail monitoring logs
npm run monitoring:down     # stop only monitoring services
```

**Metric catalog, PromQL examples, and how to export data for incidents / Cursor:** [`docs/operations-monitoring.md`](docs/operations-monitoring.md). From any host that can reach Prometheus: `PROMETHEUS_URL=http://127.0.0.1:9090 npm run metrics:snapshot` or `PROMETHEUS_URL=... npm run metrics:snapshot -- --write var/metrics-snapshot.txt`.

### Error triage workflow

1. Open Grafana → **Explore** → select **Loki**.
2. Start with `{"service":"chatapp-api"}` or search for a returned `requestId` / `x-request-id`.
3. For server faults, narrow to `"level":"error"` or the message `Unhandled error`.
4. Use the same time window in **Tempo** to inspect sampled traces for the failing path.

If you only have shell access, `docker compose logs -f api nginx` is still the fastest first look.

### Scale-up signals to watch most closely

If your main question is **"do we need a bigger prod server yet?"**, the best alerts are:

1. `ChatAppHostCpuHigh` or `ChatAppCpuSaturationHigh` for 10–15 minutes
2. `ChatAppPgPoolSaturated` or `ChatAppOverloadSheddingActive`
3. `ChatAppHighP95Latency` together with CPU / memory pressure

Those three together are the clearest early warning that prod needs more headroom.

### Discord alerting setup

Recommended channel layout:

- `local` → no alerts by default, or a personal test channel
- `staging` → `#chatapp-staging-alerts`
- `production` → `#chatapp-prod-alerts`

Set the environment and webhook in `.env`:

```bash
ALERT_ENVIRONMENT=local           # local | staging | production
DISCORD_WEBHOOK_URL_LOCAL=
DISCORD_WEBHOOK_URL_STAGING=
DISCORD_WEBHOOK_URL_PROD=
```

Then start or reload the monitoring services:

```bash
docker compose up -d --force-recreate alertmanager prometheus
```

Checks:

1. Confirm Alertmanager is healthy at `http://localhost:9093/#/status`.
2. Test the full path by temporarily stopping the API:
   ```bash
   docker compose stop api
   # wait ~2 minutes for ChatAppApiDown
   docker compose start api
   ```
3. Alerts now include the `environment` label so the message clearly says `local`, `staging`, or `production`.

> Critical alerts will ping `@here`; warning alerts will post without paging everyone. Keeping staging and prod in separate channels is the most usable setup.

### Production logging behavior

To avoid slowing down a busy server:

- successful, fast requests are mostly **suppressed in production**
- **4xx**, **5xx**, and **slow requests** are still logged
- sensitive fields like tokens, cookies, and passwords are **redacted**
- tracing is **off by default**; when enabled, production sampling defaults to `OTEL_TRACES_SAMPLE_RATIO=0.1`

Useful env knobs:

```bash
LOG_LEVEL=info
OTEL_ENABLED=false
OTEL_TRACES_SAMPLE_RATIO=0.1
```

## Testing

Run all tests from the monorepo root:

```bash
npm test
```

This runs backend Jest tests and frontend Vitest tests in sequence.

Run backend tests only (auto-provisions disposable Postgres + Redis if needed):

```bash
cd backend
npm test
```

If `DATABASE_URL` is not provided, the backend test runner starts disposable
Postgres and Redis containers, runs migrations, executes Jest, and cleans up.
In CI or other pre-provisioned environments, it uses existing environment values.

Run frontend tests only:

```bash
cd frontend
npm test
```

## Build

Build both packages from the monorepo root:

```bash
npm run build
```

### Services after startup

| Service       | URL                     | Notes                  |
|---------------|-------------------------|------------------------|
| API           | http://localhost/api/v1 | via Nginx              |
| WebSocket     | ws://localhost/ws       | via Nginx              |
| MinIO console | http://localhost:9001   | S3 object storage UI   |
| Grafana       | http://localhost:3001   | admin / admin          |

---

## Project Structure

```
chatapp/
├── backend/
│   ├── src/
│   │   ├── index.ts              Entry point (HTTP + WS server)
│   │   ├── app.ts                Express app, middleware, route mounting
│   │   ├── db/
│   │   │   ├── pool.ts           Postgres pool singleton
│   │   │   ├── redis.ts          Redis + subscriber clients
│   │   │   └── migrate.ts        SQL migration runner
│   │   ├── auth/
│   │   │   ├── passport.ts       Strategy registration (local, Google, GitHub)
│   │   │   ├── router.ts         /auth/* endpoints
│   │   │   └── usersRouter.ts    /users/* endpoints
│   │   ├── communities/router.ts  CRUD + member management
│   │   ├── channels/router.ts     Channel CRUD
│   │   ├── messages/
│   │   │   ├── router.ts          Message CRUD + read states
│   │   │   └── conversationsRouter.ts  DM conversations
│   │   ├── presence/
│   │   │   ├── service.ts         Redis TTL + fanout logic
│   │   │   └── router.ts
│   │   ├── search/
│   │   │   ├── client.ts          Postgres FTS client (tsvector + websearch_to_tsquery)
│   │   │   └── router.ts
│   │   ├── attachments/router.ts  S3 pre-sign + metadata
│   │   ├── websocket/
│   │   │   ├── server.ts          WS upgrade handler + subscription mgmt
│   │   │   └── fanout.ts          Redis publish helper
│   │   ├── middleware/
│   │   │   └── authenticate.ts    JWT verify + requireRole factory
│   │   └── utils/
│   │       ├── jwt.ts             sign/verify + deny-list
│   │       └── logger.ts          pino logger
│   ├── tests/auth.test.ts
│   ├── Dockerfile
│   └── package.json
├── migrations/
│   └── 001_initial_schema.sql     Full Postgres schema
├── infrastructure/
│   ├── nginx/nginx.conf
│   └── monitoring/prometheus.yml
├── .github/workflows/ci-cd.yml
├── docker-compose.yml
└── .env.example
```

---

## API Reference

### Authentication

| Method | Path                      | Auth | Description              |
|--------|---------------------------|------|--------------------------|
| POST   | /auth/register            | –    | Local registration        |
| POST   | /auth/login               | –    | Local login               |
| POST   | /auth/refresh             | –    | Refresh access token      |
| POST   | /auth/logout              | ✓    | Revoke tokens             |
| GET    | /auth/google              | –    | Start Google OAuth        |
| GET    | /auth/github              | –    | Start GitHub OAuth        |

All protected endpoints require: `Authorization: Bearer <accessToken>`

### Messages

| Method | Path                      | Description                        |
|--------|---------------------------|------------------------------------|
| GET    | /messages                 | Paginated history: `channelId` or `conversationId`; optional `before=<messageId>` (older page), **`after=<messageId>`** (newer page). Do not pass both `before` and `after`. Latest page is Redis-cached when neither cursor is set. |
| GET    | /messages/context/:messageId | Message window around an id (search “jump”): optional `limit` (per side, 1–50, default 25). Response includes `hasOlder` / `hasNewer` and chronological `messages`. |
| POST   | /messages                 | Send message                       |
| PATCH  | /messages/:id             | Edit own message                   |
| DELETE | /messages/:id             | Soft-delete own message            |
| PUT    | /messages/:id/read        | Update read cursor                 |

**POST /messages — retries:** send header `Idempotency-Key: <opaque string>` (≤200 chars, same user). While the key is held in Redis, duplicate posts return the same created message with **201** instead of creating twice. Optional env: `MSG_IDEM_PENDING_TTL_SECS` (in-flight lease, default 120), `MSG_IDEM_SUCCESS_TTL_SECS` (stored result, default 86400), `MSG_IDEM_POLL_DEADLINE_MS` / `MSG_IDEM_POLL_MAX_SLEEP_MS` (duplicate-lease wait: exponential backoff, default deadline 5000ms). If Redis is unavailable, idempotency is skipped so messaging still works.

### Communities

| Method | Path           | Description |
|--------|----------------|-------------|
| GET    | /communities   | All communities visible to the user (default). Optional paging: `?limit=1-100` and `?after=<communityId>` (keyset cursor from the previous page’s last row). |

### WebSocket Events

Connect: `ws://host/ws?token=<accessToken>`

**Client → Server:**
```json
{ "type": "subscribe",   "channel": "channel:<uuid>" }
{ "type": "unsubscribe", "channel": "channel:<uuid>" }
{ "type": "presence",    "status": "idle" }
{ "type": "activity" }
{ "type": "ping" }
```

**Server → Client:**
```json
{ "event": "message:created",    "data": { ...message } }
{ "event": "message:updated",    "data": { ...message } }
{ "event": "message:deleted",    "data": { "id": "..." } }
{ "event": "presence:updated",   "data": { "userId": "...", "status": "online" } }
{ "event": "community:member_joined", "data": { ... } }
{ "event": "subscribed",         "data": { "channel": "..." } }
```

### Search

```
GET /search?q=hello&communityId=<uuid>&authorId=<uuid>&after=2024-01-01&limit=20
```

---

## Cloud Deployment (4-Node Split)

### Node 1 – Database
- Services: `postgres`, `redis`
- Security group: allow 5432 and 6379 only from Node 2/3/4

### Node 2 – Proxy + Primary API
- Services: `nginx`, `api`
- Exposes port 80/443 to public internet

### Node 3 – API (replica)
- Services: `api`
- Internal traffic only (no public port)

### Node 4 – API + Monitoring
- Services: `api`, `prometheus`, `grafana`
- Grafana may be exposed with auth on a non-standard port

### Split docker-compose:
Each node uses a `docker-compose.override.yml` that includes only its services:

```bash
# Node 1
docker compose -f docker-compose.yml -f deploy/node1.yml up -d

# Node 2
docker compose -f docker-compose.yml -f deploy/node2.yml up -d
```

All nodes share the same `.env` file with connection strings pointing at Node 1's private IP.

---

## Extending the MVP

### Adding voice channels
The `channels` table has a `type` column with `voice_placeholder` enum ready.
Integrate WebRTC signaling (e.g. mediasoup) and add a signal-relay route.

### Horizontal DB scaling
The UUID primary keys and `created_at` cursors are compatible with Citus (Postgres sharding)
or read-replica routing. Replace `pool.ts` with a read/write split pool when ready.

### Scaling search
The FTS implementation in `search/client.ts` uses Postgres `tsvector` + `websearch_to_tsquery`.
To switch to a dedicated search engine, implement the same `search(q, opts)` interface in `client.ts`.
No other files need to change.

### Adding reactions, threads, polls
All extend `messages` with junction tables. The existing WebSocket fanout and Redis Pub/Sub
pattern handles their real-time delivery without structural changes.

---

## Security Checklist

- [ ] Rotate all secrets in `.env` before production
- [ ] Enable TLS in Nginx config (uncomment HTTPS server block)
- [ ] Restrict Redis and Postgres ports to VPC-internal only
- [ ] Set `NODE_ENV=production` (disables stack traces in error responses)
- [ ] Configure S3 bucket policy to private (pre-signed URLs only)
- [ ] Enable Postgres SSL (`?sslmode=require` in DATABASE_URL)
- [ ] Set up log aggregation (Loki + Grafana or ELK)
