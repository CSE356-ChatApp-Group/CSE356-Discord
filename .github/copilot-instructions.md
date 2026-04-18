# ChatApp — Copilot Instructions

## What this project is

A Discord-like chat API graded by automated bots (course autograder at CSE 356, Stony Brook). The grader sends messages and checks delivery within **15 seconds**. There are no real users. Delivery failures are scored as misses; 503s are delivery failures.

---

## Infrastructure

| Role | IP | SSH | Specs |
|------|-----|-----|-------|
| **Prod app VM** | `130.245.136.44` | `ssh ubuntu@130.245.136.44` | 8 vCPU, 16 GB, Linode |
| **Prod DB VM** | `130.245.136.21` | `ssh ubuntu@130.245.136.21` | 8 vCPU, 16 GB, Linode |
| **Staging app VM** | `136.114.103.71` | `ssh ssperrottet@136.114.103.71` | 8 vCPU, 32 GB, GCP (internal `10.128.0.2`) |
| **Staging DB VM** | `34.122.64.224` | `ssh ssperrottet@34.122.64.224` | 8 vCPU, 8 GB, GCP Debian 12 (internal `10.128.0.5`) |

CI uses GitHub-hosted `ubuntu-latest` runners (no self-hosted). Prod app runs **4 Node workers** on ports 4000–4003. Staging runs 2 workers (4000–4001). Prod DB is a remote Linode VM (`10.0.1.62` internal). Staging DB is a remote GCP VM (`10.128.0.5` internal).

---

## Stack

- **Backend**: Node.js (CommonJS + TypeScript), Express, `ws` WebSockets — `backend/src/`
- **Frontend**: Vite + React + Zustand — `frontend/src/`
- **DB**: PostgreSQL (remote VM), connection-pooled through **PgBouncer** (transaction mode, port 6432 on app VM)
- **Cache/Pubsub**: Redis (on app VM, loopback)
- **Reverse proxy**: Nginx (on app VM)
- **Process manager**: systemd `chatapp@PORT.service` (template at `deploy/chatapp-template.service`)

---

## Architecture: critical message delivery path

```
POST /api/v1/messages
  → DB INSERT (within transaction)
  → publishChannelMessageCreated() or publishConversationEventNow()
      → fanout.publish(target, payload)  — Redis PUBLISH to channel:/conversation:/user: topic
          → each node's Redis subscriber delivers to local WS clients
  → 201 response with realtimeChannelFanoutComplete / realtimeConversationFanoutComplete
```

**Key delivery files:**
- `backend/src/messages/router.ts` — POST /messages, PATCH, DELETE, PUT /read (1517 lines)
- `backend/src/messages/conversationFanoutTargets.ts` — Redis-cached DM participant lookup
- `backend/src/websocket/server.ts` — WS server, `deliverUserFeedMessage`, `deliverPubsubMessage` (1690 lines)
- `backend/src/websocket/fanout.ts` — `fanout.publish()` sends to Redis
- `backend/src/messages/reconnectReplay.ts` — replays missed messages on WS reconnect

**DM delivery specifically:** `getConversationFanoutTargets()` → Redis cache → `conversation_participants` table → Redis PUBLISH to `conversation:<id>` + `user:<id>` channels.

**Delivery tracing logs** (added commit `b89face`): look for `gradingNote: "delivery_miss_no_local_clients"` and `gradingNote: "delivery_miss_no_channel_subscribers"` in journald for missed deliveries. Look for `gradingNote: "conversation_fanout_targets"` for fanout target logging.

---

## Connection pool architecture (as of commit `a39ed84`)

```
4 Node workers × PG_POOL_MAX=80 = 320 virtual PgBouncer clients
PgBouncer default_pool_size=400 real PG connections
Oversubscription ratio: 0.8× (was 2.3× before fix — root cause of 17:51 storm)
```

**Pool circuit breaker:** `POOL_CIRCUIT_BREAKER_QUEUE=100` — throws `PoolCircuitBreakerError` (503) when `pool.waitingCount >= 100`. With 80 slots at 6ms avg queries this only fires under genuine DB catastrophe.

**PgBouncer config** (`deploy/pgbouncer-setup.py`):
- `min_pool_size=20` — warm floor, prevents cold-start burst cost
- `reserve_pool_timeout=0.5s` — was 3.0s
- `query_timeout=16s` — 1s above PG `statement_timeout=15s`
- `stats_users=chatapp` — enables `SHOW POOLS`/`SHOW STATS` for live monitoring

**Check live pool health:**
```bash
ssh ubuntu@130.245.136.44 'for p in 4000 4001 4002 4003; do curl -fsS http://127.0.0.1:$p/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(\"$p\", d[\"pool\"])"; done'
```

---

## Overload protection

`backend/src/utils/overload.ts` — detects stage 0–3 from event-loop p99 lag and RSS:
- **Stage 1** (lag>20ms): throttle presence fanout
- **Stage 2** (lag>50ms): skip presence mirror, defer search indexing, tighter replay/search limits
- **Stage 3** (lag>100ms): reject search requests, restrict non-essential writes

`OVERLOAD_HTTP_SHED_ENABLED` is **false** on prod (503s = delivery fails). Keep it false.

---

## Deployment

**Manual deploy to prod:**
```bash
./deploy/deploy-prod.sh <SHA>
# or via GitHub Actions: .github/workflows/deploy-manual.yml → environment: prod
```

**What deploy-prod.sh does on each run:** re-computes `PG_POOL_MAX`, `POOL_CIRCUIT_BREAKER_QUEUE`, `_PGB_SIZE` from live `nproc`; re-runs `pgbouncer-setup.py`; runs migrations; blue-green cutover with nginx pin; health-checks 15×.

**Check current prod SHA:**
```bash
ssh ubuntu@130.245.136.44 'cat /opt/chatapp/current/.deploy-sha 2>/dev/null || readlink /opt/chatapp/current'
```

**Pool sizing formula** (8 vCPU, 4 workers):
- `_PGB_SIZE = min(80, 70 + ncpu×20) = 80` → PgBouncer `default_pool_size=80` per worker → 400 real PG backends total? No: `_PGB_SIZE = 400`, `PG_POOL_MAX = min(80, ...) = 80`

---

## Migrations

Files in `migrations/`. Numbered prefix — run in order. **Never use `DROP INDEX CONCURRENTLY`** (can't run inside a multi-statement call — breaks CI). Use plain `DROP INDEX IF EXISTS`. See commits `b89face` (018) and `ddd2f94` (017).

New migration: create `migrations/0NN_description.sql`. The runner is `backend/scripts/run-migrations.cjs`.

---

## Key diagnostic commands

**Prod health snapshot:**
```bash
ssh ubuntu@130.245.136.44 'uptime && sudo systemctl is-active chatapp@4000 chatapp@4001 chatapp@4002 chatapp@4003 nginx pgbouncer redis'
```

**Recent errors (last 10 min):**
```bash
ssh ubuntu@130.245.136.44 'sudo journalctl -u "chatapp@*" --since "10 minutes ago" --no-pager | grep "\"level\":\"error\"\|\"level\":\"warn\"\|circuit breaker\|delivery_miss"'
```

**PgBouncer live pool stats** (now enabled via `stats_users=chatapp`):
```bash
ssh ubuntu@130.245.136.44 'psql -h 127.0.0.1 -p 6432 -U chatapp pgbouncer -c "SHOW POOLS;"'
```

**PgBouncer log tail:**
```bash
ssh ubuntu@130.245.136.44 'sudo tail -50 /var/log/pgbouncer/pgbouncer.log'
```

**DB active connections:**
```bash
ssh ubuntu@130.245.136.21 'sudo -u postgres psql chatapp_prod -qAt -c "SELECT count(*), state FROM pg_stat_activity WHERE pid != pg_backend_pid() GROUP BY state ORDER BY count DESC;"'
```

**Delivery miss investigation:**
```bash
# Look for the specific miss in journald
ssh ubuntu@130.245.136.44 'sudo journalctl -u "chatapp@*" --since "17:50" --until "17:55" --no-pager | grep -E "delivery_miss|POOL_CIRCUIT|circuit breaker"'
```

**Grader dashboard watcher:**
```bash
node frontend/scripts/grader-watch.mjs --interval 10000 >> artifacts/rollout-monitoring/grader-watch-events.jsonl 2>&1 &
tail -f artifacts/rollout-monitoring/grader-watch-events.jsonl
```

---

## Key environment variables (prod `/opt/chatapp/shared/.env`)

| Variable | Prod value | Purpose |
|----------|-----------|---------|
| `PG_POOL_MAX` | 80 | Node→PgBouncer virtual connections per worker |
| `POOL_CIRCUIT_BREAKER_QUEUE` | 100 | Queue depth before 503 |
| `CHATAPP_INSTANCES` | 4 | Number of workers |
| `FANOUT_QUEUE_CONCURRENCY` | 5 | Parallel fanout workers |
| `DISABLE_RATE_LIMITS` | true | Grader environment — no rate limiting |
| `MESSAGE_USER_FANOUT_HTTP_BLOCKING` | true | Await user fanout before 201 |
| `WS_AUTO_SUBSCRIBE_MODE` | messages | Auto-sub channel+conversation+user on connect |
| `WS_APP_KEEPALIVE_INTERVAL_MS` | 10000 | App-level WS keepalive (grader path churn) |
| `USER_FEED_SHARD_COUNT` | 64 | Redis pubsub shards for user feed |
| `AUTH_PASSWORD_STORAGE_MODE` | plain | Throughput-first (grader env) |
| `OVERLOAD_HTTP_SHED_ENABLED` | false | Keep false — 503 = grader delivery miss |
| `CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS` | 180 | DM participant cache TTL |

---

## Recent significant commits

| SHA | What |
|-----|------|
| `a39ed84` | Pool oversubscription fix: PG_POOL_MAX 230→80, CBQ 300→100, PgBouncer min_pool_size+reserve_pool_timeout+stats_users+query_timeout |
| `b89face` | Migration 018 CI fix (DROP CONCURRENTLY → DROP IF EXISTS); DM delivery tracing logs |
| `1a79193` | Drop dead indexes (018), DB disk alerts, Discord staging notifications |
| `ddd2f94` | Migration 017 CI fix (same CONCURRENTLY issue) |
| `d62f284` | WS fanout optimization, presence Redis round-trips, auth hot paths |

**Current prod SHA: `4856991`** (as of 2026-04-17). Commits `b89face` and `a39ed84` are staged on `main`, not yet deployed to prod.

---

## Known issues / watch list

1. **Pool oversubscription storm** (root cause confirmed): At 17:51 UTC 2026-04-17, PgBouncer `wait` time spiked to 5s (2.3× oversubscription, 920 virtual / 400 real). Fixed in `a39ed84`, not yet on prod.
2. **DM delivery misses** at 5:56 PM and 7:27 PM on 2026-04-17 — root cause was the 17:51 circuit breaker event. Tracing logs added in `b89face`.
3. **`DROP INDEX CONCURRENTLY` in migrations** — always use plain `DROP INDEX IF EXISTS` in `.sql` migration files.
4. **PgBouncer admin console was inaccessible** — fixed by adding `stats_users=chatapp` in `a39ed84`.

---

## Code conventions

- Backend is **CommonJS `require()`** mixed with `import` type annotations (TypeScript compiled with `tsc`). Do not convert to ESM.
- SQL queries use parameterized `$1, $2` — never string interpolation.
- All DB access via `query()`, `queryRead()`, or `withTransaction()` from `backend/src/db/pool.ts`.
- `withTransaction()` is for multi-statement atomicity only. Single queries should use `query()` directly.
- Migrations: plain SQL, numbered prefix, idempotent (`IF NOT EXISTS`, `IF EXISTS`).
- Indexes: never use `CONCURRENTLY` in migrations (runs inside a transaction block).

---

## Running tests

```bash
# Backend (provisions Docker PG + Redis automatically)
npm test                     # from repo root
npm run test --workspace=backend -- --testPathPattern=messages

# Frontend unit
npm run test --workspace=frontend

# Type check
npm run typecheck --workspace=backend

# Load test (staging)
k6 run load-tests/staging-capacity.js
```
