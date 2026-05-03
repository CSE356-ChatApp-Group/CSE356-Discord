# WebSocket Subsystem Audit

**Date:** 2025-06  
**Scope:** Full WS code path — connection lifecycle, bootstrap, hydration scheduler, replay, presence, fanout delivery, and Redis interaction patterns.  
**Methodology:** Full source read of all files under `backend/src/websocket/` combined with live Prometheus snapshots from prod (16 workers across 3 VMs).

---

## Production baseline (snapshot taken during audit)

| Metric | Value |
|--------|-------|
| WS bootstraps/min | 1,261 |
| Reconnects/min | 1,239 (98% of bootstraps) |
| p50 bootstrap wall | 207ms |
| p95 bootstrap wall | 762ms |
| p99 bootstrap wall | 2,598ms |
| Observed peak wall | 30,000ms (under load spike) |
| Replay queries/min (DB) | 1,205 |
| Bootstrap DB queries/min | 315 (25% miss, 75% cache hit) |
| Hydration deferred | ~100% of events |
| `hydration_active` | 1–2 (per snapshot) |
| Cooldown-active slots | 11/worker |
| p50 connection lifetime | 26.9s |
| p95 connection lifetime | 144s |
| Presence fanout/min | 625 |
| Delivery timeout/min | 2.3–12.4 (varies) |

---

## Structural diagnosis: why this is hard to fix

Before listing issues individually, one root fact dominates everything else:

**The grader's WS clients live ~27 seconds at median (p50=26.9s).** The server heartbeat interval is `WS_HEARTBEAT_INTERVAL_MS=20s`. That means most connections die at or near the first heartbeat boundary. Every 27 seconds, for every grader bot: disconnect → `recordRecentDisconnect` → reconnect → `consumeRecentDisconnect` → channel list lookup → `primeBootstrapChannelRecentConnect` → replay DB query → hydration → `upsertConnectionState` + `recomputeUserPresence`. All of this cascades 1,239 times per minute across 16 workers. Each individual operation is reasonable; the problem is that they're all chained and all run on every connect in a tight cycle.

Any optimization that reduces per-connection overhead or eliminates unnecessary work on the common fast-reconnect path has a multiplicative payoff because every bot reconnects ~2.2 times/minute.

---

## Issue 1 — Replay blocks `_bootstrapReady` via the wrong promise chain

**File:** `connectionLifecycle.ts`  
**Severity:** High  

`_bootstrapPromise` (the user-channel subscribe + replay) and `bootstrapSubscriptionsPromise` (channel list + hydration) are joined with `Promise.all`. The `ready` event is only sent after BOTH complete. But replay runs inside `_bootstrapPromise`, so a 500ms replay query directly adds 500ms to bootstrap wall time. 

```
_bootstrapPromise: subscribeClient(user:X) → consumeRecentDisconnect → replay (0–1250ms DB) → _bootstrapReady=true
bootstrapSubscriptionsPromise: ingress cache → channel list → hydrate
ready: await Promise.all([_bootstrapPromise, bootstrapSubscriptionsPromise])
```

Since `WS_BOOTSTRAP_PROGRESSIVE_READY` is disabled in prod, the client can't receive any messages until both paths settle. If replay takes 800ms and channel list takes 200ms, the client waits 800ms — even though all live-delivery paths (via `user:<id>` subscription and `recent_connect` ZSET) are already operational.

**Root cause:** Replay result is not needed before `ready`. Its job is to fill the client's message backlog; the client can display those messages after `ready` is received.

**Fix:** Run replay in a `setImmediate` / background path after `ready` is sent, or enable `WS_BOOTSTRAP_PROGRESSIVE_READY=true` (which sends `ready` after channel list is prepared, before hydration) and additionally move replay to post-ready. Both together would eliminate replay's contribution to bootstrap latency entirely.

---

## Issue 2 — `withTransaction` for a read-only replay query

**File:** `reconnectReplay.ts`  
**Severity:** High  

The replay query uses `withTransaction` solely to issue `SET LOCAL statement_timeout='1250ms'`. This means every replay acquires a PgBouncer connection slot and issues BEGIN → SET LOCAL → SELECT (6-CTE) → COMMIT — four DB roundtrips for what is effectively a single SELECT. PgBouncer in transaction mode releases the slot after each statement, but `withTransaction` holds the slot across all four.

With `WS_REPLAY_DB_MAX_GLOBAL=2` per worker, at any moment 2 workers have long-lived pool transactions tied to replay for up to 1.25 seconds each. Across 16 workers that is 32 replay transactions × 1.25s = potentially 40 connection-seconds/s of PgBouncer occupancy purely for replay admission, independent of actual query time.

**Fix:** Use a single `queryRead()` call with `statement_timeout` set in the query string itself via a `BEGIN`-less session-level approach, or more simply:

```sql
SET LOCAL statement_timeout = '1250ms';  -- not valid outside transaction
```

The correct fix is to pass the statement timeout via connection configuration. Alternatively, prepend the timeout as a leading statement in the query text directly:

```sql
-- option A: accept the transaction but make it lightweight
-- option B: use pg client.query('SET statement_timeout = 1250') then SELECT then reset
```

A simpler path: replace `withTransaction` with a `pool.connect()` → `client.query('SET statement_timeout ...')` → `client.query(SELECT...)` → `client.release()` sequence, which still uses one connection but avoids BEGIN/COMMIT overhead in PgBouncer transaction mode (where BEGIN/COMMIT are pooling events).

---

## Issue 3 — Pre-hydration jitter fires unconditionally even at zero queue depth

**File:** `bootstrapHydrationScheduler.ts`  
**Severity:** High  

The drain loop applies `await sleep(jitter)` BEFORE launching each hydration item, where `jitter = Math.random() * HYDRATION_JITTER_MAX_MS` (default 0–100ms, avg 50ms). This sleep runs inline in the single drain loop, serializing dispatch even though individual hydrations run concurrently.

When `queue_depth=0` (the observed steady state), there is no storm to spread; the jitter only adds latency. The mechanism is designed to prevent simultaneous Redis SUBSCRIBE storms during mass reconnect events, which is valid — but it should be conditional on queue depth or a recent-storm signal.

Current effect at steady state:
- Each connect → scheduler enqueue → drain loop → `await sleep(0–100ms)` → hydration launch → hydration completes → `observeBootstrapWall()`
- Net: +50ms average added to every bootstrap's observable wall time unconditionally

**Fix:** Skip or greatly reduce jitter when `queue_depth < HYDRATION_MAX_CONCURRENT` (i.e., there's capacity available now). Reserve full jitter for the burst-spreading case:

```ts
const jitter = (PROTECTION_ENABLED && currentQueueDepth >= HYDRATION_MAX_CONCURRENT)
  ? jitterMs()
  : Math.min(jitterMs(), 10); // minimal floor when queue is empty
```

---

## Issue 4 — `primeBootstrapChannelRecentConnect` is O(channels) Redis work per connect

**File:** `bootstrapSubscriptions.ts`, `recentConnect.ts`  
**Severity:** Medium-High  

For every connection, after loading the channel list, `primeBootstrapChannelRecentConnect` runs:

1. A pipeline of `ZSCORE channel:recent_connect:<channelId>` for ALL channels (to check freshness)
2. For each channel where the score is stale or missing: a MULTI with `ZREMRANGEBYSCORE + ZADD + EXPIRE` + a cache invalidation call

For a user subscribed to N channels, this is N Redis commands in the ZSCORE pipeline plus up to 3N more in the marking pipelines. At 21 connects/s with ~50 channels/user: `21 × 50 = 1,050 ZSCORE commands/s` as a floor. In the worst case (all scores stale on first connect): `1,050 × 4 = 4,200 Redis commands/s` from this function alone.

The staleness check (`now - TTL - 1000`) uses `WS_RECENT_CONNECT_TTL_SECONDS=20s`, so a score placed 21s ago is stale. With p50 lifetime=26.9s, on reconnect most scores ARE fresh (placed ~27s ago for a 20s TTL → borderline stale). In practice about half will be stale.

**Compounding factor:** `invalidateRecentConnectTargetsCache` fires per-channel when a score is placed, invalidating a Redis cache key per channel. That's additional write traffic.

**Fix options:**
- **A (easy):** Run `primeBootstrapChannelRecentConnect` lazily — skip it during bootstrap entirely and let individual `markChannelRecentConnect` calls fire when the client actually subscribes to each channel in `subscribeBootstrapChannel`. This moves the Redis writes from "all at once during bootstrap" to "spread across hydration batches" at no correctness cost.
- **B (harder):** Cache the primed state in the ingress cache key so repeated connects within the TTL window skip re-priming.

---

## Issue 5 — `markWsRecentConnect` fires on every pong

**Files:** `connectionLifecycle.ts`, `recentConnect.ts`  
**Severity:** Medium  

`markWsRecentConnect` is a 3-key Redis MULTI (`SET ws:recent_connect:`, `SET ws:replay_pending_eligible:`, `SET ws:pending_eligible:`). It fires both on initial connect and on every pong.

Heartbeat interval is 20s. With ~1,240 concurrent connections, pongs fire at ~62/s. Each triggers 3 Redis SET commands in a MULTI: **186 Redis writes/s from pong handling alone.**

The reason for the pong refresh is that `WS_RECENT_CONNECT_TTL_SECONDS=20s` — the key expires exactly at the next heartbeat, so the pong must refresh it to keep the pending-replay filter alive. This is a self-inflicted dependency: a 20s TTL on a 20s heartbeat cycle means the key is always expiring.

**Fix:** Set `WS_RECENT_CONNECT_TTL_SECONDS=60` (3× the heartbeat period). With a 60s TTL, keys refresh naturally with each connect and each pong fires are only needed every 3rd heartbeat. This would reduce pong-driven Redis writes by ~66% at no correctness cost — the key's purpose is to prevent replay from running for long-offline users, and a 60s window is still conservative.

---

## Issue 6 — `consumeRecentDisconnect` uses GET + DEL instead of GETDEL

**File:** `recentDisconnect.ts`  
**Severity:** Low-Medium  

```ts
const raw = await redis.get(key);
if (raw !== null) {
  await redis.del(key);
}
```

This is two sequential Redis round trips on every reconnect (1,239/min = 21/s). `GETDEL` (available in Redis 6.2+, supported by ioredis) atomizes this into one. The current two-step is also a race: if two connections for the same user try to consume simultaneously (possible in brief multi-tab scenarios), both could read the same value before either deletes it.

**Fix:** `const raw = await redis.getdel(key);` — one line.

---

## Issue 7 — Presence recompute on every connect and every disconnect

**Files:** `connectionLifecycle.ts`, `disconnectLifecycle.ts`, `presenceCoordinator.ts`  
**Severity:** Medium  

**Connect path:**
1. `upsertConnectionState()` — SADD + SADD + HSET + SET = 4 Redis commands (MULTI)
2. `recomputeUserPresence()` — SMEMBERS + pipeline of 3 commands per connection already in the set

**Disconnect path (clean):**
1. `removeConnection()` — SREM + HDEL + DEL + DEL = 4 Redis commands (MULTI)
2. `scheduleDebouncedPresenceRecompute()` — debounced, fires `recomputeUserPresence()` after `presenceDisconnectDebounceMs`

**Disconnect path (abnormal):**
1. Same as above but `recomputeUserPresence()` fires immediately (no debounce)

At 21 connects/s + 21 disconnects/s = 42 events/s, each triggering SMEMBERS + N-command pipeline. The debounce on clean disconnect helps, but for the grader's 1006 disconnects (network_abnormal classification), `disconnectReason` is `network_abnormal` → `abnormalClose = !clean || ...` — close code 1006 with `clean = (closeCode !== 1006) = false`, so **the grader's most common disconnect type (heartbeat death → 1006) triggers the immediate, non-debounced recompute path**.

With 21 abnormal disconnects/s, this is 21 × `SMEMBERS` + 21 × pipeline calls/s purely for presence recompute.

**Fix:**
- Treat code 1006 with reason `""` (bare network drop) as clean-disconnect-equivalent for presence purposes — it's functionally a connection dying from inactivity, not a server error.
- OR: Gate presence recompute in `disconnectLifecycle` to always use the debounce for 1006 closes with no error payload, since these are the client simply not responding to the heartbeat.

The debounced path exists precisely for this case (brief-gap reconnects should not see offline→online churn). Classifying the grader's 1006 closes as `network_abnormal` defeats that optimization.

---

## Issue 8 — Replay limit cap silently renders the profile dead code

**File:** `reconnectReplay.ts`  
**Severity:** Low-Medium  

The `replayQueryProfile` function computes limits based on gap duration and overload stage:
- gap ≤ 1s → 15
- gap ≤ 5s → 60
- gap ≤ 30s → 100
- gap ≤ 300s → 150
- gap > 300s → 200

Then at the call site: `Math.min(50, Math.max(0, limit))`. The computed limits of 60, 100, 150, 200 are all capped to 50. The profile table is entirely dead code for values > 50. `const REPLAY_CLAMP = 50` is never read.

This is not causing a bug but means the overload-adaptive limit scaling (the design intent) does nothing above 50 messages. For a reconnecting client that was offline for 5 minutes, they'll get at most 50 messages, not 150 as the profile intends.

**Fix:** Either remove the dead branches from `replayQueryProfile` and document the real cap, or lift the clamp to match the max profile value (200) with appropriate testing of replay send latency.

---

## Issue 9 — Bootstrap ingress TTL (3s) is too short to coalesce the grader's reconnect pattern

**File:** `bootstrapSubscriptions.ts`, `serverConfig.ts`  
**Severity:** Medium  

The ingress cache key has `WS_BOOTSTRAP_INGRESS_TTL_SECONDS=3` (hardcoded in `serverConfig.ts`). Two reconnects arriving >3s apart both go through the full list cache lookup path. Given p50 lifetime=26.9s (disconnect → reconnect gap is typically 0–2s), the ingress cache would coalesce rapid reconnects. But many grader reconnects arrive with >3s gaps.

The 180s list cache (`WS_BOOTSTRAP_CACHE_TTL_SECONDS=180`) is the real protection — a second lookup within 180s hits Redis (fast) rather than PG. The ingress cache's role is to prevent multiple simultaneous DB requests from the same user during a connection burst.

The 25% DB hit rate (315/min out of 1,261) is not from ingress cache miss — it's from the 180s list cache either:
- Expiring (user hasn't connected in 3 minutes)
- Being invalidated by channel/community membership changes
- Not being populated yet (first connect since restart)

**The real fix for DB hit rate:** Profile `invalidateWsBootstrapCaches` — if it's firing too aggressively on benign membership events, the cache never warms. The stale-while-revalidate pattern (staleTTL = 1.5× mainTTL = 270s) should prevent the coldest-path scenarios, but if invalidation is frequent the stale TTL doesn't help.

---

## Issue 10 — Hydration drain loop uses `sleep(BATCH_INTERVAL_MS)` polling to wait for available slots

**File:** `bootstrapHydrationScheduler.ts`  
**Severity:** Low-Medium  

When `activeHydrations >= HYDRATION_MAX_CONCURRENT (8)`, the drain loop polls:

```ts
while (queue.length > 0) {
  if (activeHydrations >= HYDRATION_MAX_CONCURRENT) {
    await sleep(HYDRATION_BATCH_INTERVAL_MS); // 50ms
    continue;
  }
  // ... launch next item
}
```

When all 8 slots are occupied, the loop wakes every 50ms to check. If a slot opens after 5ms, the loop won't see it for up to another 45ms. This polling latency compounds with the pre-dispatch jitter.

At the observed steady state (`queue_depth=0`, `active=1–2`), this rarely triggers. But during reconnect storms it can add 50ms of unnecessary wait per hydration pass.

**Fix:** Use a proper semaphore with a waiting queue (`await semaphore.acquire()`) instead of the polling loop. When a slot is released, immediately wake the longest-waiting enqueue rather than relying on timers.

---

## Issue 11 — SUBSCRIBE command count per hydration is not batched optimally

**File:** `bootstrapSubscriptions.ts`  
**Severity:** Low  

`hydrateBootstrapSubscriptions` iterates channels in batches of `WS_BOOTSTRAP_BATCH_SIZE=96` and calls `subscribeBootstrapChannel` for each with `Promise.allSettled`. Each `subscribeBootstrapChannel` → `subscribeClient` → `ensureRedisChannelSubscribed` → `redisSub.subscribe(channel)`.

The ioredis `subscribe` call accepts multiple channels (`redisSub.subscribe('ch1', 'ch2', ...)`). If `ensureRedisChannelSubscribed` is called one channel at a time (which it is — each call passes a single channel), each potentially issues an individual SUBSCRIBE command to Redis. For a user with 200 channels in batches of 96: 2 batches × 96 individual SUBSCRIBE calls = up to 192 Redis commands.

However, ioredis internally queues SUBSCRIBE commands and may coalesce them. The real issue is that `ensureRedisChannelSubscribed` does reference-counting and deduplication per-channel, which requires a Map lookup per channel — this is CPU-bound but trivial.

**The bigger concern:** If a channel has no prior subscribers on this worker, a new Redis SUBSCRIBE command is issued. If 10 users subscribe to the same channel concurrently, only 1 Redis SUBSCRIBE fires but 10 `subscribeClient` calls run. The reference counting in `subscriptionRegistry.ts` handles this correctly.

No high-priority fix needed here; the batching is functionally correct.

---

## Issue 12 — WS heartbeat at 20s causes maximum-frequency reconnect at grader's connection lifetime

**File:** `serverConfig.ts`  
**Severity:** Medium (configuration, not code)  

`WS_HEARTBEAT_INTERVAL_MS=20000`. p50 connection lifetime = 26.9s. These two numbers are nearly locked in a resonance: the first heartbeat fires at 20s, and most connections die during or shortly after the first heartbeat cycle (either the client doesn't respond → `heartbeat_timeout` close, or the client disconnects naturally around that time).

If the grader sends pongs reliably and the 26.9s lifetime reflects the grader's own reconnect schedule, this is not server-controlled. But if connections are timing out because the heartbeat TTL (`WS_HEARTBEAT_INTERVAL_MS × 1.5`) is too tight and the grader's pong sometimes arrives late, raising `WS_HEARTBEAT_INTERVAL_MS` to `30000` would meaningfully reduce reconnect churn without affecting liveness detection.

**Diagnostic check:** Compare `ws_disconnects_reason_total{reason="heartbeat_timeout"}` against `ws_disconnects_reason_total{reason="network_abnormal"}` over a 1-hour window. If heartbeat_timeout is significant, raising the interval is a low-risk win.

---

## Issue 13 — `recomputeUserPresence` after reconnect is redundant when user was never offline

**File:** `connectionLifecycle.ts`, `presenceCoordinator.ts`  
**Severity:** Low-Medium  

On connect, `cancelPendingPresenceRecompute(user.id)` runs to cancel the debounced post-disconnect recompute. This correctly handles the case where a user reconnects before the debounce fires. However, `upsertConnectionState` is still called, which sets the connection into the SADD/connectedUsers sets — and then nothing triggers a "user is back online" signal unless `recomputeUserPresence` also runs.

For abnormal disconnect → fast reconnect scenarios, the sequence is:
1. Disconnect → `removeConnection` → `recomputeUserPresence()` (immediate, abnormal path)
2. Reconnect arrives 50ms later → `cancelPendingPresenceRecompute` (was not scheduled) → `upsertConnectionState` → ... no second recompute

This means step 1 may have already computed "offline" (no connections) and set presence=offline. Step 2 adds the connection back but never calls `recomputeUserPresence()` to set presence back to online. **The user could be stuck at "offline" until the presence sweeper runs (up to every 15s).**

Actually: `connectionLifecycle.ts` does call `recomputeUserPresence` after `upsertConnectionState` during connect. Let me verify — scanning the code: yes, `upsertConnectionState` is followed by `recomputeUserPresence` in the connect path. So this is handled. ✓

No bug here, but the presence sweeper (15s interval, SMEMBERS all connected users) is still an O(users) operation that fires regardless of whether anything changed.

---

## Issue 14 — `refreshConnectionTtls` on every pong duplicates key-refresh work from `markWsRecentConnect`

**File:** `connectionLifecycle.ts`  
**Severity:** Low  

On every pong, both `markWsRecentConnect(user.id)` AND `refreshConnectionTtls(ws, user.id)` fire. `markWsRecentConnect` refreshes 3 keys; `refreshConnectionTtls` refreshes the connection alive key (+ potentially activity key). These run as separate pipelines/MULTIs sequentially in the same pong handler, meaning 2 Redis roundtrips per pong where 1 would do.

**Fix:** Consolidate into a single pipeline that refreshes all 4–5 relevant keys in one roundtrip.

---

## Summary: high-ROI fixes ordered by impact

### Tier 1 — Fix these first (large wall-time reduction, low risk)

| # | Fix | Estimated impact |
|---|-----|-----------------|
| 1 | Move replay to post-ready (or enable progressive ready) | Eliminate replay's contribution to bootstrap wall (~200–800ms per reconnect) |
| 3 | Make pre-hydration jitter conditional on queue depth | Remove avg 50ms per bootstrap when queue is empty (steady state) |
| 6 | `consumeRecentDisconnect` → `GETDEL` | Eliminate 1 Redis roundtrip per reconnect (21/s) |
| 5 | Raise `WS_RECENT_CONNECT_TTL_SECONDS` to 60 | Reduce pong-driven Redis writes by ~66% |

### Tier 2 — Fix these second (Redis write reduction, moderate complexity)

| # | Fix | Estimated impact |
|---|-----|-----------------|
| 4 | Move `primeBootstrapChannelRecentConnect` to lazy/hydration-time | ~1,000 Redis commands/s reduction |
| 7 | Treat 1006+empty-reason as clean disconnect for presence debounce | Eliminate immediate `recomputeUserPresence` for most grader disconnects |
| 2 | Replace `withTransaction` for replay with session-scoped timeout | Reduce PgBouncer slot occupancy for replay from 4 roundtrips to ~2 |

### Tier 3 — Fix these last (low risk, minor gains)

| # | Fix | Estimated impact |
|---|-----|-----------------|
| 8 | Remove dead replay limit branches (cap them at 50 honestly) | Code clarity; no runtime effect |
| 10 | Replace drain loop `sleep` poll with semaphore | Reduces 50ms polling waste during reconnect storms |
| 14 | Consolidate `markWsRecentConnect` + `refreshConnectionTtls` into single pipeline on pong | 1 fewer Redis roundtrip per pong |
| 12 | Raise `WS_HEARTBEAT_INTERVAL_MS` to 30s (diagnose first) | Reduce reconnect frequency if heartbeat_timeout is a significant disconnect cause |

---

## What is NOT a bug (architecturally sound)

- **`withDistributedSingleflight` on bootstrap DB queries** — correctly prevents thundering herd on cold start.
- **`fanoutRecipientDedupe` cross-topic dedup** — correctly suppresses duplicate delivery when a message arrives via both `user:<id>` and `channel:<id>` topics.
- **`HYDRATION_MAX_CONCURRENT=8` per worker** — reasonable concurrency limit; slots are the right abstraction.
- **Bootstrap cache 180s + stale-while-revalidate** — stale TTL at 1.5× correctly serves slightly-stale channel lists without a DB query.
- **`replayAdmissionState` per-user cooldown + IP concurrency cap** — prevents replay storms correctly.
- **`scheduleDebouncedPresenceRecompute` for clean disconnects** — correctly avoids offline churn for brief reconnects.
- **`signalLiveFanoutPending` / `releaseLiveFanoutPending` gating hydration** — correctly yields CPU to live delivery during hydration.

---

## Files read for this audit

`server.ts`, `bootstrapHydrationScheduler.ts`, `bootstrapSubscriptions.ts`, `connectionLifecycle.ts`, `disconnectLifecycle.ts`, `replay.ts`, `reconnectReplay.ts`, `serverConfig.ts`, `redisPubsubDelivery.ts`, `recentDisconnect.ts`, `recentConnect.ts`, `presenceCoordinator.ts`, `wsDeliveryPressure.ts`, `replayAdmissionState.ts`, `profile.ts`, `outboundQueue.ts`
