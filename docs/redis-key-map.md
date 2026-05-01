# Redis key and channel reference

Status: operational  
Owner: platform-operations  
Last reviewed: 2026-05-01

This document lists **principal Redis keys and Pub/Sub topic patterns** used by the backend. It is a **grep-friendly operators’ map**: behavior remains defined in code ([`backend/src/db/redis.ts`](../backend/src/db/redis.ts) and call sites). Update this file when you add long-lived key families or change naming for fanout.

**Related:** metric names for list-cache tuning — [`operations-monitoring.md`](operations-monitoring.md) (section *Redis list-cache tuning*). Tunables — [`env.md`](env.md), [`docs/README.md`](README.md).

---

## Pub/Sub fanout (logical channels)

Subscribers use these **topic strings** (not the same as persistence keys):

| Pattern | Purpose |
|---------|---------|
| `channel:<uuid>` | Channel message realtime (`channelRealtimeFanout.ts`, WS subscribe) |
| `conversation:<uuid>` | DM / conversation realtime |
| `community:<uuid>` | Community-scoped signals |
| `user:<uuid>` | Per-user delivery (legacy / targeted); WS subscribe |
| `userfeed:<0–N-1>` | Sharded user feeds (`USER_FEED_SHARD_COUNT`, `userFeed.ts`) |

---

## Message list cache (first-page JSON)

| Pattern | Purpose |
|---------|---------|
| `messages:channel:<channelId>[:v<epoch>][:l<limit>]` | Cached first-page channel history (`messageCacheBust.ts`) |
| `messages:channel:<channelId>:cacheEpoch` | Epoch bump → invalidates in-flight cache writes |
| `messages:conversation:<conversationId>[:v<epoch>][:l<limit>]` | Cached first-page DM history |
| `messages:conversation:<conversationId>:cacheEpoch` | Epoch for DM message list |

TTL for message lists is **`MESSAGES_CACHE_TTL_SECS`** in [`backend/src/messages/lib/messageListCache.ts`](../backend/src/messages/lib/messageListCache.ts) (default **15s**, code constant).

---

## Channel / community API caches

| Pattern | Purpose |
|---------|---------|
| `channels:list:<communityId>:<userId>` | GET channels list JSON (`channels/routes/list.ts`) |
| `community:<communityId>:members` | Community members cache (`communities/cacheKeys.ts`) |

Channel list TTL: **`CHANNELS_LIST_CACHE_TTL_SECS`** (`channelRouterShared.ts`, env override).

---

## Unread acceleration (channel counters)

| Pattern | Purpose |
|---------|---------|
| `channel:msg_count:<channelId>` | Total messages counter (string); reconcile paths in `channelMessageCounter.ts` |
| `user:last_read_count:<channelId>:<userId>` | Read watermark for unread derivation (`channels/routes/list.ts`) |
| `channel:msg_count:reconcile:*` | Reconcile lock / cooldown keys |

---

## Presence

| Pattern | Purpose |
|---------|---------|
| `presence:<userId>` | Aggregate status string, TTL refresh (`presence/service.ts`) |
| `presence:<userId>:away_message` | Optional away text |
| `presence:<userId>:fanout_targets` | Cached recipient list JSON for presence fanout |
| `presence_db_cursor:<userId>` | CAS cursor for mirroring presence to Postgres |
| `user:<userId>:connections` | SET of connection ids |
| `user:<userId>:connection_status` | HASH connectionId → per-connection status |

Per-connection activity/alive keys are built in [`backend/src/websocket/presenceCoordinator.ts`](../backend/src/websocket/presenceCoordinator.ts) (`connectionActivityKey`, `connectionAliveKey`).

---

## Read receipts & read-state helpers

| Pattern | Purpose |
|---------|---------|
| `read_cursor_ts:<userId>:ch:<channelId>` | Redis CAS cursor timestamp (channel read) |
| `read_cursor_ts:<userId>:cv:<conversationId>` | CAS cursor (DM read) |
| `read_db_lock:<userId>:ch:<channelId>` | Async PG flush coordination |
| `read_db_lock:<userId>:cv:<conversationId>` | DM variant |

Lua scripts and batch keys — [`backend/src/messages/lib/readReceiptState.ts`](../backend/src/messages/lib/readReceiptState.ts), [`backend/src/messages/readState/batchReadState.ts`](../backend/src/messages/readState/batchReadState.ts).

---

## Access control & fanout target caches

| Pattern | Purpose |
|---------|---------|
| `channel:<channelId>:user_fanout_targets_v` | Version key for channel user fanout targets (`accessVersionCache.ts`) |
| `conversation:<conversationId>:fanout_targets_v` | Conversation fanout version |
| `rc_targets:<channelId>` | Recent-connect fanout targets cache (`channelRecentConnectTargets.ts`) |
| `ch_compat:<uuid>:<userId>` | Legacy conversationId→channel resolution (`accessCaches.ts`) |

Message-target JSON caches use scoped keys from [`backend/src/messages/accessCaches.ts`](../backend/src/messages/accessCaches.ts) and [`backend/src/utils/versionedAccessCache.ts`](../backend/src/utils/versionedAccessCache.ts).

---

## WebSocket bootstrap

| Pattern | Purpose |
|---------|---------|
| `ws:bootstrap:<userId>:<scope>` | Bootstrap payload cache (`bootstrapSubscriptions.ts`) |
| Related ingress keys | See `wsBootstrapIngressKey` / invalidation in same module |

---

## Auth

| Pattern | Purpose |
|---------|---------|
| `deny:<accessToken>` | JWT deny-list entry until token expiry (`utils/jwt.ts`) |

---

## POST /messages idempotency

| Pattern | Purpose |
|---------|---------|
| `msg:idem:<userId>:<sha256>` | Idempotency lease / replay payload (`messages/routes/post.ts`) |

---

## Misc operational keys

| Pattern | Purpose |
|---------|---------|
| Rate limits / abuse | e.g. `cji:`, `cju:` (`joinRateLimit.ts`), `rum:` (`rum/limiter.ts`) |
| Redis Lua script hashes | Registered in [`backend/src/db/redisLua.ts`](../backend/src/db/redisLua.ts) |

---

## What not to expect here

- **Exact** enumeration of every temporary key (Lua internals, test-only prefixes).
- **Pub/Sub payload schemas** — see realtime contracts in [`docs/architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md).
