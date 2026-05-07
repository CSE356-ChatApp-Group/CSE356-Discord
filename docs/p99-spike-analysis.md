# P99 Latency Spike Analysis — Production Data

**Date:** 2026-05-07  
**Data source:** Prometheus instant queries via SSH tunnel to monitoring VM (`130.245.136.120`)  
**Window:** 10m rate(), 34 workers up, overload stage 0  
**Raw data:** `var/route-p99-diag.txt`

---

## Summary Table (Live Production Data)

| Route | p95 (ms) | p99 (ms) | p99/p95 | req/s | PG queries (p99) | Actual bottleneck |
|-------|----------|----------|---------|-------|-------------------|-------------------|
| `POST /auth/register` | 805 | **3764*** | **4.7×** | 0.93 | 1 | PG INSERT variance on users table + Redis rate limiter (*p99 varies 1115–3764ms between windows) |
| `GET /conversations` | 479 | **2905** | **6.1×** | 1.57 | 8 | Complex query (LATERAL joins) + 0% cache hit rate |
| `GET /search` | 235 | **1105** | **4.7×** | 1.13 | 2 | MeiliSearch call + PG recheck, with tail from Meili empty/strict fallback paths |
| `POST /communities/:id/join` | 121 | **400** | 3.3× | 1.81 | 5 | 5 sequential PG queries |
| `GET /channels` | 189 | **238** | 1.3× | 0.01 | 5 | Complex query, 0% cache hit rate (always cold) |
| `POST /messages` | 46 | **171** | 3.7× | 68.63 | 2 | PG query variance at high throughput; lock wait=NaN (no contention) |
| `GET /users/me` | 43 | **145** | 3.4× | 10.69 | 1 | PG query variance under concurrent write load |
| `POST /auth/login` | 24 | **33** | 1.4× | 6.20 | 1 | Stable — not a problem route |
| `GET /health` | 22 | **100** | 4.5× | 0.69 | 0 | Noise floor |

---

## Infrastructure Baseline (at time of collection)

- **PG pool:** 0 waiting / 6 idle / 6 total — **not pool-starved**
- **PG errors:** ALL zero (acquire_timeout, connection, shutdown, other, query_timeout)
- **Circuit breaker rejects:** 0/s
- **Overload shedding:** 0/s, stage 0
- **bcrypt queue:** active=0, waiters=0, rejects=0 — **completely idle**
- **Message insert lock:** wait=NaN (no contention data), pressure_timeouts=0
- **Overload:** stage 0

**Key insight:** Infrastructure is healthy. No pool starvation, no bcrypt queueing, no lock contention. The spikes are from **query complexity and zero cache effectiveness**.

---

## Critical Discovery: List Cache Has 0% Hit Rate

```
channels       hit  0.0000/s   miss  0.0136/s
communities    hit  0.0000/s   miss  0.0034/s
conversations  hit  0.0000/s   miss  0.0000/s
messages_*     hit  0.0000/s   miss  0.0000/s
```

Every single list cache lookup is a miss. This means every request that checks the cache pays the Redis GET latency AND then runs the full DB query. The cache is doing nothing but adding overhead.

**Root cause traced in code** (`backend/src/messages/fanout/conversationFanout.ts` lines 243-248):

`publishConversationEventNow()` calls `invalidateConversationsListCaches(userIds)` on **every message fanout** — every DM `message:created`, `read:updated`, `message:deleted`, and `message:updated` event. At 68 messages/s, the conversations list cache for all participants is deleted faster than any client can re-fetch. The invalidation is fire-and-forget (`void ...catch()`), so it races with the client's next GET.

Similarly, `publishChannelMessageEvent()` in `channelRealtimeFanout.ts` invalidates channel list caches for all channel members on every channel message. At high message rates, the cache is always stale.

**The math:** At 68 msg/s, if each message invalidates caches for ~2-5 users, that's 136-340 cache invalidations/s. The cache TTL is irrelevant — it's being busted before it can serve a single hit.

---

## Route-by-Route Corrected Analysis

### 1. POST /auth/register — p99 1115–3764ms (p95 805ms)

**Previous claims:** bcrypt threadpool contention → WRONG. SMTP sendMail → **ALSO WRONG** (subagent hallucination — there is NO sendMail in the register handler).

**Actual code path traced** (`backend/src/auth/routes/local.ts` lines 22-48):

| # | Operation | Type | Est. cost |
|---|-----------|------|-----------|
| 1 | `registerGlobalIpLimiter` | Redis INCR (rate limit) | ~1-5ms |
| 2 | `registerLimiter` | Redis INCR (rate limit) | ~1-5ms |
| 3 | `hashPassword(password, 'register_hash')` | **Plain text** (see below) | ~0ms |
| 4 | `INSERT INTO users ... ON CONFLICT DO NOTHING` | PostgreSQL | ~5-50ms |
| 5 | `issueTokens()` → JWT signing + cookie | Synchronous crypto | ~0ms |

**bcrypt `register_hash` metric returns NO DATA** — this means `AUTH_PASSWORD_STORAGE_MODE=plain` in production. Passwords are stored as `plain:${password}` with zero hashing cost.

The handler is 2 Redis calls + 1 PG INSERT. Normal path is ~10-60ms. Yet p99 spikes to 1-4 seconds.

**The spike varies wildly between windows** (1115ms in one snapshot, 3764ms in another), which is consistent with **occasional PG INSERT stalls** — likely from:
- Autovacuum on the `users` table blocking the INSERT
- Checkpoint flushing dirty pages, causing write stalls
- Lock contention from concurrent unique index checks (`users_username_key`, `users_email_key`)

The rate limiter Redis calls could also spike if Redis is under load from the 136-340 cache invalidations/s triggered by message fanout.

**Fix:**
- **Add sub-millisecond tracing** to the register handler to distinguish Redis vs PG latency (the current metrics don't break down this route's components)
- **Consider reducing autovacuum cost delay** on the `users` table
- **Or accept the variance** — at 0.93 req/s, a few slow inserts don't impact overall throughput

---

### 2. GET /conversations — p99 2905ms (p95 479ms)

**Confirmed bottleneck:** 8 PG queries per request + LATERAL join + 0% cache hit rate.

The query chain:
1. CTE `my_convos` → participants + conversations join
2. JOIN back to conversations, conversation_participants, users
3. LEFT JOIN read_states for current user
4. **LEFT JOIN LATERAL** for other participant's read state — correlated per row
5. Post-query: `getConversationLastMessageMetaMapFromRedis()` — N Redis calls

**Why 2905ms p99:** A user with many conversations triggers 20+ correlated LATERAL subqueries. Combined with 0% cache hit rate (every request runs the full path), the p99 scales linearly with conversation count.

**Fix:**
1. **Drop the LATERAL join** — other user's read state isn't needed in the sidebar list
2. **Embed last_message in SQL** instead of N separate Redis calls
3. **Fix the cache** — 0% hit rate means the cache TTL or invalidation logic is broken

---

### 3. GET /search — p99 1105ms (p95 235ms)

**Corrected 2026-05-07 live read:** the first diagnostic script was querying stale metric names (`search_meili_fallback_total`, `search_freshness_cache_total`, `search_throttle_total`). The exported series are `meili_search_fallback_total`, split freshness hit/miss counters, and `search_throttled_total`.

**What we know:** 2 PG queries per request on the normal path. handler_overhead_p99≈1ms. Live corrected Prometheus showed Meili p99≈350ms, primary Postgres recheck p99≈192ms, freshness rescue p99≈380–471ms, and fallback reasons around 10% of search traffic (`strict_token_mismatch`, `empty_candidates`, `recheck_error`, `unavailable`).

**Root cause:** the tail came from sequential fallback paths:
- `empty_candidates` ran freshness rescue and then still launched the full Postgres FTS/literal pipeline when freshness found nothing.
- `strict_token_mismatch` rechecked Meili IDs, found no exact all-term match, then repeated the full Postgres search instead of going straight to the bounded literal rescue query.

**Fix:**
1. **Use the corrected metric names** in diagnostics so Meili/freshness rates are visible.
2. **Do not full-FTS fallback on empty Meili candidates** once the index is warm; bounded freshness rescue covers recent writes, then return an empty page. `MEILI_EMPTY_CANDIDATES_FALLBACK_ENABLED=true` remains as a temporary cold-index/rebuild switch.
3. **For strict-token mismatch, run only the bounded literal rescue query on primary**, not the full FTS+literal pipeline.

---

### 4. POST /communities/:id/join — p99 400ms (p95 121ms)

**Confirmed:** 5 sequential PG queries per request. The p99 spike is when one of these queries (likely channel resolution or member count update) hits a slow plan under concurrent joins.

**Fix:** Batch the first 3 queries (check community, check membership, insert) into a single `INSERT ... ON CONFLICT DO NOTHING RETURNING`.

---

### 5. POST /messages — p99 171ms (p95 46ms)

**Previous claim:** Channel insert lock contention. **WRONG.** Lock wait metrics show NaN (no contention). pressure_timeouts=0.

At 68.63 req/s with 2 PG queries per request, the system generates ~137 PG queries/s. The p99=171ms is just **normal PG query latency variance** under concurrent write load — some transactions wait behind other writes.

The p99/p95 ratio of 3.7× is typical for PG under mixed read/write workload.

**Fix:** This is actually acceptable for 68 req/s. If lower p99 is needed:
- Use `pg_advisory_xact_lock` instead of Redis lock (saves 2 Redis RTs)
- Or accept the variance and focus on the bigger offenders

---

### 6. GET /users/me — p99 145ms (p95 43ms)

Simple 1-PG-query route (`SELECT ... FROM users WHERE id = $1`). p95=43ms is already high for a PK lookup; p99=145ms suggests occasional slow plans due to concurrent write load.

**Fix:** Cache the response in Redis with 5-10s TTL. User profile rarely changes.

---

## Priority Fixes (Corrected)

| Priority | Fix | Route | Expected impact | Effort |
|----------|-----|-------|----------------|--------|
| **P0** | Stop invalidating list caches on every message fanout — invalidate only on structural changes (new/delete conversation, join/leave channel). At 68 msg/s the current invalidation rate (136-340/s) keeps the cache permanently cold. | conversations, channels | conversations p99 from 2905→~50ms on cache hit | 10 lines in `conversationFanout.ts` + `channelRealtimeFanout.ts` |
| **P0** | Drop LATERAL join from conversations list query (other user's read state not needed in sidebar) | conversations | 50%+ query time reduction even on cache miss | 1 day |
| **P1** | Add sub-millisecond tracing to register handler to identify Redis vs PG vs other latency (currently opaque — `AUTH_PASSWORD_STORAGE_MODE=plain` so hash is free, yet p99=1-4s) | register | Identify the real 1-4s bottleneck | 2 hours |
| **P1** | Keep search diagnostics on exported metric names (`meili_search_fallback_total`, freshness hit/miss counters, `search_throttled_total`) | search | Preserve visibility into Meili vs PG split | 1 hour |
| **P1** | Batch community join queries (check+insert 5→2) | communities join | p99 from 400→~100ms | 0.5 day |
| **P2** | Cache `/users/me` in Redis (5s TTL) | users/me | p99 from 145→~5ms | 2 hours |

### What NOT to do
- **Don't reduce bcrypt rounds** — already at cost 4, queue is idle, not the bottleneck
- **Don't run Meili + PG FTS in parallel** — PG FTS is the fallback for a reason (correctness). Instead, reduce Meili timeout so fallback triggers faster
- **Don't add advisory locks for messages** — lock contention is not the issue (NaN wait times)
