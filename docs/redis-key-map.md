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
| `userfeed:<0–N-1>` | Sharded user feeds (`USER_FEED_SHARD_COUNT`, `userFeed.ts`). Workers now subscribe lazily: a worker owns only the `userfeed` shards needed by its currently connected `user:<id>` sockets, and releases them when the last local owner disconnects. |

---

## Message list cache (first-page JSON)

| Pattern | Purpose |
|---------|---------|
| `messages:channel:<channelId>[:v<epoch>][:l<limit>]` | Cached first-page channel history (`messageCacheBust.ts`) |
| `messages:channel:<channelId>:cacheEpoch` | Epoch bump → invalidates in-flight cache writes |
| `messages:conversation:<conversationId>[:v<epoch>][:l<limit>]` | Cached first-page DM history |
| `messages:conversation:<conversationId>:cacheEpoch` | Epoch for DM message list |

TTL for message lists is **`MESSAGES_CACHE_TTL_SECS`** in [`backend/src/messages/lib/messageListCache.ts`](../backend/src/messages/lib/messageListCache.ts) (default **15s**, code constant).
Epoch counter retention is bounded by **`MESSAGE_CACHE_EPOCH_TTL_SECS`** (default **2592000** s / 30d) so dormant scopes do not accumulate immortal counter keys.

---

## Channel / community API caches

| Pattern | Purpose |
|---------|---------|
| `channels:list:<communityId>:<userId>` | GET channels list JSON (`channels/routes/list.ts`) |
| `community:<communityId>:members` | Community members cache (`communities/cacheKeys.ts`) |

Channel list TTL: **`CHANNELS_LIST_CACHE_TTL_SECS`** (`channelRouterShared.ts`, env override).

---

## Conversations list cache

| Pattern | Purpose |
|---------|---------|
| `conversations:list:<userId>` | `GET /api/v1/conversations` JSON (`conversationsRouterListCache.ts`) |
| `stale:conversations:list:<userId>` | Stale-while-revalidate companion (`distributedSingleflight.ts`) |

TTL: **`CONVERSATIONS_LIST_CACHE_TTL_SECS`** (default **60** s). Invalidation: `invalidateConversationsListCaches` on membership changes; DM **`message:*`** fanout calls the same helper (not a raw `DEL` of the fresh key only).

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
| `health:message_insert_unhealthy` | Fleet-visible insert-timeout pressure flag (`SET`/`GET` with **`PX`** from **`READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS`**). Writers **`SET`** on qualifying **`POST /messages`** timeouts; readers poll on a background interval (`READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS`), not per request — [`backend/src/messages/messageInsertHealth.ts`](../backend/src/messages/messageInsertHealth.ts). |
| `read_receipt_msg_ack:<userId>:<messageId>` | Optional duplicate-ack fast path for **`PUT /messages/:id/read`** when **`READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED`** is on (`SET`/`GET` with **`PX`** from **`READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS`**). Set only after successful handling with confirmed access — [`backend/src/messages/readReceipt/readReceiptMessageAckCache.ts`](../backend/src/messages/readReceipt/readReceiptMessageAckCache.ts). |
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
| `channel:recent_connect:<channelId>` | Per-channel recent-connect ZSET used by `CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect` |
| `channel:bootstrap_pending:<channelId>` | Short-lived ZSET for users whose websocket bootstrap or post-connect join/invite subscribe push has not yet joined `channel:<id>`; keeps the userfeed bridge only for that gap when `CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH=true`; TTL is `CHANNEL_BOOTSTRAP_PENDING_TTL_SECONDS` |
| `ch_compat:<uuid>:<userId>` | Legacy conversationId→channel resolution (`accessCaches.ts`) |

Message-target JSON caches use scoped keys from [`backend/src/messages/accessCaches.ts`](../backend/src/messages/accessCaches.ts) and [`backend/src/utils/versionedAccessCache.ts`](../backend/src/utils/versionedAccessCache.ts).
Fanout version-key retention is bounded by **`FANOUT_CACHE_VERSION_KEY_TTL_SECS`** (default **2592000** s / 30d).

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
