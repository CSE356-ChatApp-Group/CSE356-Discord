# Production Architecture & Performance Context Map

Generated: 2026-05-04  
Status: FACTUAL (confirmed from live prod env, deployed code, and infrastructure inventory)  
Purpose: Pre-tuning context. No recommendations — just the map.

---

## 1. Production Topology

### App VMs
- **3 VMs** (Linode, `ubuntu-intelbroadwell`): each **8 vCPU / 16 GB RAM**
  - VM1: `130.245.136.44` (runs nginx reverse proxy + 4 Node workers)
  - VM2: `130.245.136.137` (6 Node workers)
  - VM3: `130.245.136.54` (6 Node workers)
- **Total workers: 16** (4 + 6 + 6)
- Ports: VM1 `chatapp@4000`–`chatapp@4003`; VM2/VM3 `chatapp@4000`–`chatapp@4005`
- Each worker: `--max-old-space-size=479` MB heap, `UV_THREADPOOL_SIZE=8`

### Nginx (on VM1 only)
- Upstream `app` lists VM1 localhost ports + VM2/VM3 private IPs
- See `deploy/nginx/admission-control.conf` for rate limiting / buffering

### Redis
- **Managed Redis** on private VLAN: `10.0.1.233:6379` (maxmemory 6 GiB, volatile-lru)
- `redis_exporter` runs on VM1 (Docker host network) at `:9121`

### PgBouncer
- Runs on **each app VM** (`127.0.0.1:6432`)
- `PGBOUNCER_POOL_SIZE=90`, `PGBOUNCER_MAX_DB_CONNECTIONS=100`
- `PGBOUNCER_MIN_POOL_SIZE=5`, `PGBOUNCER_RESERVE_SIZE=5`
- Transaction-mode pooling (connections released between transactions)

### PostgreSQL 16 Primary
- DB VM: `130.245.136.21` (8 vCPU, 16 GB RAM)
- Data on 100 GB NVMe at `/mnt/DB-NVMe/16/nvme`, port 5432
- Database: `chatapp_prod`
- Each app worker: `PG_POOL_MAX=25` connections to local PgBouncer → 16 workers × 25 = 400 possible pool connections across 3 VMs, but PgBouncer caps at 90 per VM

### PostgreSQL Read Replica
- `db-vm-2`: internal `10.0.2.88:5432` (async streaming replication)
- `PG_READ_REPLICA_URL` set on all VMs; `PG_READ_FALLBACK_TO_PRIMARY=true`
- `PG_READ_QUERY_TIMEOUT_MS=750`

### Meilisearch
- Dedicated VM: `10.0.0.146:7700` (4 vCPU / 8 GB RAM)
- **Live prod: `MEILI_ENABLED=true`, `SEARCH_BACKEND=meili`** (confirmed on all 3 VMs)

### Monitoring
- Monitoring VM: `130.245.136.120` (4 vCPU / 8 GB RAM) — Grafana, Prometheus, Loki, Tempo
- node-exporter + Promtail on each app VM
- Prometheus scrapes `/metrics` on every worker port on each app private IP

---

## 2. Runtime Settings Affecting Message Delivery

| Setting | Live Prod Value | Source |
|---------|----------------|--------|
| `PG_POOL_MAX` | 25 | per-worker PgBouncer pool |
| `POOL_CIRCUIT_BREAKER_QUEUE` | 100 | per-worker pool guard |
| `MESSAGE_INSERT_LOCK_MODE` | `optimistic` | **bypasses Redis lock entirely** |
| `MESSAGE_INSERT_LOCK_ENABLED` | `true` | overridden by `mode=optimistic` |
| `MESSAGE_POST_SYNC_FANOUT` | `false` | fanout is async enqueue |
| `CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH` | `true` | no per-user PUBLISH for channel msgs |
| `CHANNEL_MESSAGE_USER_FANOUT_MODE` | `recent_connect` | only recently-active users |
| `MESSAGE_POST_FAST_ACCEPT_ENABLED` | `true` | skip DB hydrate for channel msgs |
| `MESSAGE_POST_AWAIT_CACHE_BUST` | `false` | cache bust is fire-and-forget |
| `WS_HEARTBEAT_MISSED_PINGS_BEFORE_KILL` | `1` | kill on first missed ping |
| `WS_RECENT_CONNECT_TTL_SECONDS` | `120` | 2-min window for recent-connect |
| `WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT` | `true` | prefer Redis pending over DB replay |
| `FANOUT_QUEUE_CONCURRENCY` | `6` | in-process async fanout workers |
| `SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY` | `1` | Meili indexing is single-threaded |
| `MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED` | `false` | no immediate bridge |
| `MESSAGE_USER_FANOUT_HTTP_BLOCKING` | `true` | HTTP blocks on fanout enqueue |
| `CHANNEL_MESSAGE_USER_FANOUT_MAX` | `10000` | cap on fanout targets |
| `PG_CONNECTION_TIMEOUT_MS` | `7000` | TCP connect timeout |
| `MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS` | `5000` | DM insert statement timeout |
| `BCRYPT_ROUNDS` | `1` | minimum cost (grading speed) |
| `PRESENCE_DB_MIRROR_MODE` | `async` | presence writes are fire-and-forget |

---

## 3. POST /messages Request Path (Current Deployed Code)

**Files:** `post.ts` → `postInsertPhase.ts` → `postFanout.ts` → `postFinish.ts`

```
Client → nginx → worker
  │
  ├─ 1. Rate limit (IP + user rate limiters)
  │     `post.ts:131-132`
  │
  ├─ 2. Validate payload (channelId/conversationId, content, attachments)
  │     `post.ts:186-199`
  │
  ├─ 3. Idempotency lease (Redis SET NX)
  │     `post.ts:200-213`
  │     - Key: `msg:idem:<userId>:<sha256(key)>`, TTL 300s
  │     - Returns cached 201 if duplicate
  │
  ├─ 4. DB insert (`runPostInsertPhase`)
  │     `postInsertPhase.ts:200-434`
  │     │
  │     ├─ CHANNEL path:
  │     │   `shouldBypassChannelInsertLock()` → true (optimistic mode)
  │     │   → Runs `withTransaction(client => runChannelInsertTransaction(...))`
  │     │   → Single merged SQL: INSERT INTO messages ... SELECT ... FROM channels c
  │     │     JOIN communities co ... WHERE c.id=$1 AND (access checks)
  │     │     RETURNING ... + author subquery + community_id
  │     │   → `synchronous_commit = off` inside transaction
  │     │   → Attachments: separate transaction after main insert
  │     │
  │     └─ DM path:
  │         → `withTransaction(client => runConversationInsertTransaction(...))`
  │         → INSERT INTO messages ... SELECT ... FROM conversation_participants
  │           WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL
  │           RETURNING ... + author subquery
  │         → Attachments in same transaction
  │
  ├─ 5. Build response message
  │     `post.ts:284-307`
  │     - If FAST_ACCEPT + channelId: use INSERT-RETURNING row directly (no extra SELECT)
  │     - Else: `loadHydratedMessageById()` → extra SELECT+JOIN for author/attachments
  │
  ├─ 6. Cache bust (fire-and-forget, started in parallel with fanout)
  │     `post.ts:315-331` — `bustMessagesCacheSafe({ channelId, conversationId })`
  │     - `MESSAGE_POST_AWAIT_CACHE_BUST=false` → does NOT await before response
  │     - Timeout: `MESSAGE_POST_CACHE_BUST_TIMEOUT_MS` (default)
  │
  ├─ 7. Fanout (`runChannelMessageCreatedFanout` / `runConversationMessageCreatedFanout`)
  │     `postFanout.ts:48-240` / `postFanout.ts:242-396`
  │     │
  │     ├─ CHANNEL fanout (async mode, `messagePostAsyncFanoutEnabled()=true`):
  │     │   a. `sideEffects.enqueueFanoutJob("fanout.message_post.channel", ...)` 
  │     │      → in-process queue (FANOUT_QUEUE_CONCURRENCY=6)
  │     │   b. Job calls `publishChannelMessageCreated(channelId, envelope, { communityId })`
  │     │      → `channelRealtimeFanout.ts:446-588`
  │     │      → Resolve user targets (recent_connect mode → Redis ZRANGEBYSCORE)
  │     │      → `enqueuePendingMessageForUsers()` (Redis ZADD per-user pending mailbox)
  │     │      → `fanout.publish("channel:<id>", envelope)` (Redis PUBLISH)
  │     │      → `publishCommunityFeedMessage()` if public channel
  │     │      → User topic PUBLISH skipped (`CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true`)
  │     │   c. If queue full → fallback to inline publish (fire-and-forget)
  │     │
  │     └─ DM fanout (async mode):
  │         a. Enqueue job → `publishConversationEventNow(conversationId, "message:created", msg)`
  │            → Redis PUBLISH on `conversation:<id>`
  │
  ├─ 8. 201 response + idempotency cache + Meili index
  │     `postFinish.ts:19-266`
  │     - Community signal (fire-and-forget Redis PUBLISH on `community:<id>`)
  │     - Idempotency cache write (Redis SET)
  │     - `res.status(201).send(jsonBody)` ← **response sent here**
  │     - Meili `indexMessage()` via `setImmediate()` (batched, non-blocking)
  │
  └─ 9. Background (after response)
        - Channel last-message pointer update (`scheduleChannelLastMessagePointerUpdate`)
        - Meili batch flush (50ms interval or batch-size trigger)
```

**Key timing: response is sent at step 8, BEFORE fanout job completes (async mode).**

---

## 4. WebSocket Delivery Path

### Connection Setup (`connectionLifecycle.ts:209-448`)

```
Client WebSocket upgrade → authenticate (JWT) → handleConnection()
  │
  ├─ 1. Mark recent connect: `markWsRecentConnect(userId)` → Redis ZADD
  │     `connectionLifecycle.ts:282`
  │
  ├─ 2. Subscribe to `user:<userId>` (personal feed)
  │     `connectionLifecycle.ts:284`
  │     → On success: consume recent-disconnect, set bootstrapReady=true
  │     → If recent disconnect: fire reconnect replay
  │
  ├─ 3. Bootstrap channel/conversation subscriptions (progressive mode)
  │     `connectionLifecycle.ts:354-367`
  │     → `prepareBootstrapWithRetry()` → loads user's channels from DB
  │     → Subscribes to each `channel:<id>` topic
  │     → Progressive: sends `ready` event before full hydration
  │     → Then hydrates and sends `bootstrap:complete`
  │
  ├─ 4. Presence: upsert connection state → recompute presence
  │     `connectionLifecycle.ts:343-352`
  │
  └─ 5. Heartbeat: ping/pong every 30s, kill on 1st missed ping
```

### Channel Message Delivery (how a connected client receives a message)

```
Redis PUBLISH on `channel:<id>` (from fanout job)
  │
  ├─ Each worker's Redis subscriber receives the message
  │   → Fanout dispatch: find local WS sockets subscribed to `channel:<id>`
  │   → For each matching socket: `ws.send(JSON.stringify(envelope))`
  │
  ├─ Pending replay: `enqueuePendingMessageForUsers()` wrote per-user ZSET
  │   → On reconnect: `replayPendingMessagesToSocket()` drains ZSET
  │   → If `WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT=true` and pending had messages,
  │     skip DB replay entirely
  │
  └─ No user-topic PUBLISH (`CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true`)
      → Delivery relies ENTIRELY on `channel:<id>` subscription
      → Sockets still bootstrapping may miss messages → recovered by:
        a. Pending replay (Redis ZSET)
        b. DB replay on reconnect (messages since last_disconnect)
```

### Reconnect Recovery Path

```
Client reconnects → WS upgrade → auth → subscribe `user:<id>`
  → consumeRecentDisconnect(userId) → returns timestamp
  → runReconnectReplay():
    1. Admission gate: semaphore (WS_REPLAY_SEMAPHORE_MAX=6)
    2. Prefer Redis pending replay (ZSET drain)
    3. If pending replay produced messages AND WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT=true → skip DB
    4. Else: DB replay → SELECT messages WHERE created_at > disconnect_time
    5. Drain remaining pending after DB replay
```

---

## 5. DB Usage Map

### POST /messages (Channel)

| Table | Operation | Phase |
|-------|-----------|-------|
| `messages` | INSERT (merged with access check) | Main transaction |
| `channels` | SELECT (JOIN for access check) | Inside INSERT subquery |
| `communities` | SELECT (JOIN for access check) | Inside INSERT subquery |
| `community_members` | EXISTS subquery | Inside INSERT subquery |
| `channel_members` | EXISTS subquery (if private) | Inside INSERT subquery |
| `users` | Correlated subquery (author JSON) | RETURNING clause |
| `attachments` | INSERT (if attachments) | Separate transaction |
| `channels` | UPDATE `last_message_*` | Background (if pool guard passes) |
| `channels` | SELECT for last_message | Background cache bust |

### POST /messages (DM)

| Table | Operation | Phase |
|-------|-----------|-------|
| `messages` | INSERT (merged with participant check) | Main transaction |
| `conversation_participants` | SELECT (FROM for access check) | Inside INSERT subquery |
| `users` | Correlated subquery (author JSON) | RETURNING clause |
| `attachments` | INSERT (if attachments) | Same transaction |
| `conversations` | UPDATE `last_message_*` | Background |

### Channel Message Replay (reconnect)

| Table | Operation |
|-------|-----------|
| `messages` | SELECT by channel_id WHERE created_at > $1 AND deleted_at IS NULL |

### DM Send

Same as POST /messages (DM) above.

### Read State Update

| Table | Operation |
|-------|-----------|
| `read_states` | UPSERT (INSERT ON CONFLICT UPDATE) |
| `messages` | SELECT MAX(created_at) for cursor computation |

### Presence Update

| Table | Operation |
|-------|-----------|
| `ws_connections` | INSERT/UPDATE (connection state) |
| `users` | UPDATE `presence_status` |
| Presence writes batched via `PRESENCE_DB_MIRROR_MODE=async` (1s flush, batch 250) |

### Search Fallback (when Meili fails → Postgres)

| Table | Operation |
|-------|-----------|
| `messages` | SELECT with `content_tsv @@ to_tsquery(...)` + channel/community filter |
| Uses GIN indexes `idx_messages_tsv` and `idx_messages_channel_tsv` | 

---

## 6. Bottleneck History

### 6a. Redis Fanout Amplification (FIXED)
- **Problem:** Per-user `PUBLISH` on `user:<id>` for every channel message = O(N) Redis commands per message
- **Fix:** `CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true` + `CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect`
- **Evidence:** Code comment at `channelRealtimeFanout.ts:556` — `CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH` gate

### 6b. Pg Insert Latency / Lock Contention (FIXED)
- **Problem:** Hot channels → concurrent INSERTs contend on btree/GIN pages → 50-200ms per INSERT → insert lock queue fills → 4s timeouts → 503 cascade
- **Fix:** `MESSAGE_INSERT_LOCK_MODE=optimistic` bypasses Redis lock; `synchronous_commit=off` inside transaction; merged SQL avoids extra SELECT
- **Evidence:** `channelInsertConcurrency.ts:1-7` header comment; the 3:57 PM error logs showed `message_insert_lock_wait_timeout` and `message_insert_lock_recent_shed`

### 6c. Read States HOT Update Issue
- **Problem:** `read_states` UPSERT on HOT-update-unfriendly page layout → excessive page splits
- **Current:** Migration 019 added `message_created_at` to read_states; `READ_STATE_FLUSH_PRESSURE_*` settings gate flush frequency
- **Evidence:** `READ_STATE_FLUSH_DEFER_ON_DB_PRESSURE_ENABLED=true`, `READ_STATE_FLUSH_PRESSURE_MAX_DEFER_MS=60000`

### 6d. Event Loop Pressure
- **Problem:** JSON serialization of large fanout payloads blocks event loop; `JSON.stringify(httpBody)` measured in traces
- **Current:** `serializationWallMs` tracked in `postFinish.ts:151`; response bodies are modest
- **Evidence:** `OVERLOAD_LAG_SHED_MS=250` exists but `OVERLOAD_HTTP_SHED_ENABLED=false`

### 6e. Socket Write Queue Backup
- **Problem:** Slow clients → `ws.send()` buffers → memory pressure → eventual timeout
- **Current:** `_outboundQueue` per socket (connectionLifecycle.ts:267); kill on 1st missed heartbeat (`WS_HEARTBEAT_MISSED_PINGS_BEFORE_KILL=1`)
- **Evidence:** Comment at connectionLifecycle.ts:42-43 — "Immediate kill keeps subscriber maps clean"

### 6f. Cache Bust Waiting (FIXED)
- **Problem:** `bustMessagesCacheSafe()` awaited inline → blocked 201 response
- **Fix:** `MESSAGE_POST_AWAIT_CACHE_BUST=false` → fire-and-forget
- **Evidence:** `post.ts:386-414` — async `.then()` chain after response

### 6g. Sync Fanout Blocking HTTP (FIXED)
- **Problem:** `MESSAGE_POST_SYNC_FANOUT=true` → HTTP awaited full fanout → multi-second p99
- **Fix:** `MESSAGE_POST_SYNC_FANOUT=false` → async enqueue
- **Evidence:** `postFanout.ts:75` — `messagePostAsyncFanoutEnabled()` gates the path

### 6h. Presence DB Mirror Writes
- **Problem:** Synchronous presence writes on every connect/disconnect → DB contention
- **Fix:** `PRESENCE_DB_MIRROR_MODE=async` with 1s flush interval, batch 250
- **Evidence:** `connectionLifecycle.ts:343-352` — presence init is fire-and-forget

---

## 7. Current Likely Bottleneck Ranking

Based on the deployed configuration and code, ranked from most to least likely:

### 1. **PgBouncer / Postgres connection saturation under burst**
- **Evidence:** 16 workers × `PG_POOL_MAX=25` = up to 400 connections across 3 VMs, but each PgBouncer caps at 90. Under burst, all 90 slots fill → `POOL_CIRCUIT_BREAKER_QUEUE=100` → requests queue in Node → HTTP latency spikes
- **Confidence:** HIGH — historical bottleneck confirmed in `docs/infrastructure-inventory.md:34`
- **Metrics to check:** `pg_pool_waiting`, `pg_pool_checkout_duration_ms`, `pgbouncer.cl_active`

### 2. **Fanout job queue latency (async enqueue → actual Redis PUBLISH)**
- **Evidence:** `FANOUT_QUEUE_CONCURRENCY=6` processes fanout jobs. Under 200 msg/sec burst, each job does: resolve targets (Redis ZRANGEBYSCORE + SMISMEMBER), pending enqueue (Redis ZADD × N users), channel PUBLISH. If jobs take 20-50ms each, 6 concurrent → ~120-300 jobs/sec throughput. Queue can fall behind.
- **Confidence:** MEDIUM — `fanout_job_latency_ms` metric would confirm
- **Impact:** Messages are committed to DB but not delivered via WS until fanout job runs

### 3. **Reconnect replay DB load (under mass reconnect)**
- **Evidence:** `WS_REPLAY_SEMAPHORE_MAX=6`, `WS_REPLAY_DB_MAX_IN_FLIGHT=4`. Each replay does a SELECT on `messages` with time-range filter. Under mass reconnect (e.g., grader restart), hundreds of replays queue behind 6 slots.
- **Confidence:** MEDIUM — `ws_replay_defer_*` metrics would confirm
- **Mitigation:** `WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT=true` helps if pending replay covers the gap

### 4. **Redis latency on fanout target resolution**
- **Evidence:** `resolveActiveChannelMessageTargets()` does: `ZRANGEBYSCORE` (recent connect) + `SMISMEMBER` (active presence filter) + `ZADD` (pending enqueue per user) + `PUBLISH` (channel topic). Under load, Redis single-threaded processing can add 5-20ms per step.
- **Confidence:** MEDIUM-LOW — Redis at 6 GiB with volatile-lru should be fast unless evicting heavily

### 5. **Meili backfill / indexing lag**
- **Evidence:** `SEARCH_SIDE_EFFECT_QUEUE_CONCURRENCY=1` — single-threaded Meili batch indexing. If Meili was recently enabled, unbackfilled historical messages return zero candidates → fallback to Postgres FTS → GIN index queries → adds DB load.
- **Confidence:** LOW-MEDIUM — depends on how complete the Meili index is
- **Check:** `meili_search_fallback_total` metric

### 6. **GIN index maintenance on INSERT (still present)**
- **Evidence:** Even with optimistic lock mode, each INSERT still updates `idx_messages_tsv` and `idx_messages_channel_tsv` (both GIN). With Meili active, these indexes are no longer needed for search queries but still add write overhead.
- **Confidence:** LOW (mitigation available but not yet applied) — dropping GIN indexes would reduce per-INSERT work
- **Check:** `pg_stat_user_indexes.idx_tup_fetch` near zero for GIN indexes confirms they're unused

---

## Appendix: Key File Reference

| Component | File |
|-----------|------|
| POST /messages orchestrator | `backend/src/messages/routes/post.ts` |
| DB insert phase | `backend/src/messages/routes/postInsertPhase.ts` |
| Fanout logic | `backend/src/messages/routes/postFanout.ts` |
| 201 response + traces | `backend/src/messages/routes/postFinish.ts` |
| Insert lock / optimistic bypass | `backend/src/messages/channelInsertConcurrency.ts` |
| Channel realtime fanout | `backend/src/messages/fanout/channelRealtimeFanout.ts` |
| SQL fragments (merged INSERT) | `backend/src/messages/sqlFragments.ts` |
| WS connection lifecycle | `backend/src/websocket/connectionLifecycle.ts` |
| Meilisearch client | `backend/src/search/meiliClient.ts` |
| Search routing | `backend/src/search/client.ts` |
| Metrics definitions | `backend/src/utils/metrics.ts` |
| Prod env (git) | `deploy/env/prod.required.env` |
| Infrastructure inventory | `docs/infrastructure-inventory.md` |
| Nginx config | `deploy/nginx/admission-control.conf` |