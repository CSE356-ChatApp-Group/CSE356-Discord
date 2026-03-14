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
│   │   ├── index.js              Entry point (HTTP + WS server)
│   │   ├── app.js                Express app, middleware, route mounting
│   │   ├── db/
│   │   │   ├── pool.js           Postgres pool singleton
│   │   │   ├── redis.js          Redis + subscriber clients
│   │   │   └── migrate.js        SQL migration runner
│   │   ├── auth/
│   │   │   ├── passport.js       Strategy registration (local, Google, GitHub)
│   │   │   ├── router.js         /auth/* endpoints
│   │   │   └── usersRouter.js    /users/* endpoints
│   │   ├── communities/router.js  CRUD + member management
│   │   ├── channels/router.js     Channel CRUD
│   │   ├── messages/
│   │   │   ├── router.js          Message CRUD + read states
│   │   │   └── conversationsRouter.js  DM conversations
│   │   ├── presence/
│   │   │   ├── service.js         Redis TTL + fanout logic
│   │   │   └── router.js
│   │   ├── search/
│   │   │   ├── client.js          Meilisearch wrapper
│   │   │   └── router.js
│   │   ├── attachments/router.js  S3 pre-sign + metadata
│   │   ├── websocket/
│   │   │   ├── server.js          WS upgrade handler + subscription mgmt
│   │   │   └── fanout.js          Redis publish helper
│   │   ├── middleware/
│   │   │   └── authenticate.js    JWT verify + requireRole factory
│   │   └── utils/
│   │       ├── jwt.js             sign/verify + deny-list
│   │       └── logger.js          pino logger
│   ├── tests/auth.test.js
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
| GET    | /messages                 | Paginated history (cursor-based)   |
| POST   | /messages                 | Send message                       |
| PATCH  | /messages/:id             | Edit own message                   |
| DELETE | /messages/:id             | Soft-delete own message            |
| PUT    | /messages/:id/read        | Update read cursor                 |

### WebSocket Events

Connect: `ws://host/ws?token=<accessToken>`

**Client → Server:**
```json
{ "type": "subscribe",   "channel": "channel:<uuid>" }
{ "type": "unsubscribe", "channel": "channel:<uuid>" }
{ "type": "presence",    "status": "idle" }
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
GET /search?q=hello&channelId=<uuid>&authorId=<uuid>&after=2024-01-01&limit=20
```

---

## Cloud Deployment (4-Node Split)

### Node 1 – Database
- Services: `postgres`, `redis`
- Security group: allow 5432 and 6379 only from Node 2/3/4

### Node 2 – Proxy + Primary API
- Services: `nginx`, `api`
- Exposes port 80/443 to public internet

### Node 3 – API + Search
- Services: `api`, `meilisearch`
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
or read-replica routing. Replace `pool.js` with a read/write split pool when ready.

### Replacing Meilisearch with OpenSearch
Implement the same interface in `search/client.js` using `@opensearch-project/opensearch`.
No other files change.

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
