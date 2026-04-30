# ChatApp — Copilot Instructions

## What this project is

A Discord-like chat API graded by automated bots (course autograder at CSE 356, Stony Brook). The grader sends messages and checks delivery within **15 seconds**. There are no real users. Delivery failures are scored as misses; 503s are delivery failures.

---

## Infrastructure

Canonical hosts, sizes, and SSH users: [`docs/infrastructure-inventory.md`](../docs/infrastructure-inventory.md). Default prod IPs for deploy scripts: [`deploy/inventory-defaults.sh`](../deploy/inventory-defaults.sh).

| Role | Public IP (defaults) | SSH user |
|------|----------------------|----------|
| **Prod app VM1** (nginx + workers) | `130.245.136.44` | `ubuntu` |
| **Prod app VM2 / VM3** | `130.245.136.137`, `130.245.136.54` | `ubuntu` |
| **Prod DB** | `130.245.136.21` | `ubuntu` |
| **Prod monitoring** (Grafana/Prometheus stack) | `130.245.136.120` | `ubuntu` |
| **Staging app** | `136.114.103.71` | `ssperrottet` |
| **Staging DB** | `34.122.64.224` | `ssperrottet` |

CI uses GitHub-hosted `ubuntu-latest` runners. **Production** is **multi-VM**: nginx on VM1, Node workers on VM1–VM3 (16 workers total in the default layout — see inventory). **Redis** in prod is **managed** on a private VLAN (`REDIS_URL` on app hosts), not loopback on the API VM. **Staging** is typically **fewer workers** than prod (often dual-worker); exact `CHATAPP_INSTANCES` comes from `/opt/chatapp/shared/.env` on that host.

---

## Stack

- **Backend**: Node.js (CommonJS + TypeScript), Express, `ws` WebSockets — `backend/src/`
- **Frontend**: Vite + React + Zustand — `frontend/src/`
- **DB**: PostgreSQL (dedicated VM in prod/staging), connection-pooled through **PgBouncer** (transaction mode, port 6432 on app hosts where deployed)
- **Cache/Pubsub**: Redis (**managed** in prod; local/docker in dev — see `REDIS_URL` / inventory)
- **Reverse proxy**: Nginx (**prod VM1** entry; staging topology in inventory)
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
- `backend/src/messages/router.ts` — POST /messages, PATCH, DELETE, PUT /read
- `backend/src/messages/conversationFanoutTargets.ts` — Redis-cached DM participant lookup
- `backend/src/websocket/server.ts` — WS server, `deliverUserFeedMessage`, `deliverPubsubMessage`
- `backend/src/websocket/fanout.ts` — `fanout.publish()` sends to Redis
- `backend/src/messages/reconnectReplay.ts` — replays missed messages on WS reconnect

**DM delivery specifically:** `getConversationFanoutTargets()` → Redis cache → `conversation_participants` table → Redis PUBLISH to `conversation:<id>` + `user:<id>` channels.

**Delivery tracing logs** (added commit `b89face`): look for `gradingNote: "delivery_miss_no_local_clients"` and `gradingNote: "delivery_miss_no_channel_subscribers"` in journald for missed deliveries. Look for `gradingNote: "conversation_fanout_targets"` for fanout target logging.

---

## Connection pool architecture

Each **`chatapp@`** worker holds a **virtual** pool to PgBouncer; **total** virtual clients = workers × `PG_POOL_MAX` **across all app hosts**. Deploy scripts recompute `PG_POOL_MAX`, `POOL_CIRCUIT_BREAKER_QUEUE`, and PgBouncer `default_pool_size` from live `nproc` and inventory (see `deploy/deploy-prod-remote-sizing.sh`).

**Pool circuit breaker:** `POOL_CIRCUIT_BREAKER_QUEUE` (commonly **100** in required env) throws `PoolCircuitBreakerError` (**503**) when `pool.waitingCount` exceeds the threshold — see `backend/src/db/pool.ts` and alerts around **`ChatAppPgPoolPressure`** / **`ChatAppPgPoolSevereSaturation`** in `infrastructure/monitoring/alerts.yml`.

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

**Manual deploy to prod (typical multi-VM):**
```bash
./deploy/deploy-prod-multi.sh <SHA>
# Single-host / legacy path:
./deploy/deploy-prod.sh <SHA>
# or via GitHub Actions: .github/workflows/deploy-manual.yml → environment: prod
```

**What the prod scripts do (high level):** merge required env, recompute pool sizing where applicable, run migrations, rolling worker/nginx steps — see [`deploy/README.md`](../deploy/README.md).

**Check current prod SHA:**
```bash
ssh ubuntu@130.245.136.44 'cat /opt/chatapp/current/.deploy-sha 2>/dev/null || readlink /opt/chatapp/current'
```

**Pool sizing:** computed per host from `nproc` and merged env in `deploy/deploy-prod-remote-sizing.sh` (not a single fixed “4 workers × 80” story across the whole cluster).

---

## Migrations

Files in `migrations/`. Numbered prefix — run in order. **Never use `DROP INDEX CONCURRENTLY`** (can't run inside a multi-statement call — breaks CI). Use plain `DROP INDEX IF EXISTS`. See commits `b89face` (018) and `ddd2f94` (017).

New migration: create `migrations/0NN_description.sql`. The runner is `backend/scripts/run-migrations.cjs`.

---

## Key diagnostic commands

**Prod health snapshot:**
```bash
ssh ubuntu@130.245.136.44 'uptime && sudo systemctl is-active chatapp@4000 chatapp@4001 chatapp@4002 chatapp@4003 nginx pgbouncer'
# Redis in prod is usually managed off-box — check `REDIS_URL` / inventory, not necessarily a local `redis` systemd unit.
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

**Source of truth:** merged **`deploy/env/prod.required.env`** into shared `.env` on every deploy, full catalog in [`docs/env.md`](../docs/env.md). Do **not** treat old “grader-only” snippets as current prod — e.g. prod **`DISABLE_RATE_LIMITS=false`**, **`USER_FEED_SHARD_COUNT=64`**, **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`**, **`WS_AUTO_SUBSCRIBE_MODE=user_only`**, **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`**, **`OVERLOAD_HTTP_SHED_ENABLED=false`** (503s are still bad for grading when they occur for other reasons).

---

## Git history

Use `git log` for incident-linked SHAs; avoid pinning “current prod SHA” in this file (it goes stale immediately).

---

## Known issues / watch list

1. **`DROP INDEX CONCURRENTLY` in migrations** — migrations run in a transaction wrapper; use plain `DROP INDEX IF EXISTS` (see migration comments in-repo).
2. **Pool / PgBouncer / replica** — triage with [`docs/RUNBOOKS.md`](../docs/RUNBOOKS.md) and Prometheus alerts in `infrastructure/monitoring/alerts.yml`.

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
