# WebSocket parity: `GeneratedClient` (grader harness) vs this backend

This document ties the **frozen** harness client behavior to server behavior so ops and graders know what is guaranteed without editing the client.

## Code map (single sources of truth)

| Concern | Location |
| --- | --- |
| Canonical vs **alias** event names, optional `REALTIME_EVENT_ALIAS_FANOUT`, **message dedupe family**, and **reliable** (no best-effort drop) classification | [`backend/src/realtime/realtimeEventAliases.ts`](../backend/src/realtime/realtimeEventAliases.ts) |
| WS outbound JSON shape, dedupe keys, backpressure skip rules | [`backend/src/websocket/outboundPayload.ts`](../backend/src/websocket/outboundPayload.ts) |
| Upgrade auth, `ready`, subscribe path, queues | [`backend/src/websocket/server.ts`](../backend/src/websocket/server.ts) |
| Redis → local delivery, `__wsInternal` subscribe forwarding | [`backend/src/websocket/redisPubsubDelivery.ts`](../backend/src/websocket/redisPubsubDelivery.ts) |
| Env tunables reference | [`docs/env.md`](env.md) (search `WS_`, `REALTIME_EVENT_ALIAS_FANOUT`, `USER_FEED_SHARD_COUNT`) |

The reference client:

- Connects to `/ws?token=<JWT>` (and may send `Cookie` headers; the server **authenticates WebSocket upgrades using the query token only**).
- Sets `wsReady = true` only after a top-level `event === 'ready'`.
- Treats `msg.__wsInternal.kind === 'subscribe_channels'` as invite hints **only when `wsReady` is already true** (avoids classifying bootstrap subscription lists as invites).
- Uses a fixed `switch (event)` for realtime; events **not** listed there are ignored.

## Server guarantees aligned to this client (no client changes)

| Client expectation | Server behavior |
| --- | --- |
| `ready` before normal traffic | Emitted after user-topic subscribe + bootstrap complete ([`server.ts`](../backend/src/websocket/server.ts)). |
| `message:created` | Primary fanout name for new messages; payload includes `channel_id` / `conversation_id` (and related fields) so `mapMessage` can set `conversationId`. |
| `message:updated` / `message:deleted` | Emitted with DB-shaped rows; outbound frames include `channel: <logical-topic>` for delete routing when ids are only on the topic. |
| `read:updated` | Emitted with `userId`, `channelId`, `conversationId`, `lastReadMessageId` as needed for read-receipt handlers. |
| `presence:updated` | Fanout with `data.userId`, `data.status`, etc.; inbound `{ type: 'presence' \| 'away_message' }` is accepted on the socket. |
| DM / conversation invites | `conversation:invited`, `conversation:invite`, `conversation:created` (and related) published for invite flows ([`conversationsRouter.ts`](../backend/src/messages/conversationsRouter.ts)). |
| `__wsInternal.subscribe_channels` on wire | After server-side auto-subscribe, the same internal payload is **sent to the browser** so the client’s post-`ready` invite path can run ([`redisPubsubDelivery.ts`](../backend/src/websocket/redisPubsubDelivery.ts)). |
| Community join on `community:` topic | On `POST /communities/:id/join`, the server publishes **`community:member_joined`** (legacy name), **`community:joined`**, and **`community:member_added`** with the same `{ userId, communityId }` payload ([`communities/router.ts`](../backend/src/communities/router.ts)). The client’s `switch` includes `community:joined` and `community:member_added` but **not** `community:member_joined`; the extra names exist so `onInvite` fires without client edits. |

## Optional: `REALTIME_EVENT_ALIAS_FANOUT`

**What it does:** When set to `1` / `true` / `yes`, [`fanout.publish` / `publishBatch`](../backend/src/websocket/fanout.ts) duplicate selected Redis publishes with **alternate event names** on the **same** channel (see [`realtimeEventAliases.ts`](../backend/src/realtime/realtimeEventAliases.ts)): e.g. `new_message` beside `message:created`, read-receipt aliases beside `read:updated`, etc.

**Does the shipped `GeneratedClient` need it?** **No.** That client already branches on the **canonical** names for messages, edits, deletes, presence, and reads (`message:created`, `message:updated`, …, `read:updated`, `presence:updated`). Alias fanout is **not** required for parity with the pasted `handleWsMessage`.

**When to enable:** External graders or third-party clients that **only** listen for legacy names (`new_message`, `message:read`, …). Default **off** avoids duplicate Redis traffic and duplicate handler risk on permissive clients.

**Should it exist?** **Yes, as an opt-in escape hatch** until you are sure no environment depends on alternate names. Removing it would delete a small amount of code and one env knob; keep it if you want zero redeploy when a harness insists on a non-canonical event name.

**Production default:** Leave **unset / off**. Turn on only in staging or for a specific grader profile.

## Suggested client changes (if you can edit the harness later)

These are **not** required for correct behavior against the current server; they reduce confusion and duplicate `onInvite` noise.

1. **`case 'community:member_joined':`**  
   **Reason:** The server still emits this name for backward compatibility. Handling it the same as `community:joined` / `community:member_added` avoids relying on ordering if you ever stop emitting one of the aliases.

2. **Deduplicate `onInvite` for the same `community:<id>`**  
   **Reason:** A member may receive **`subscribe_channels`** (with `community:<id>`) **and** one or more community-topic events (`community:joined`, `community:member_added`, …) in quick succession. Coalescing by id prevents double UI or double harness assertions.

3. **`community:invite` server event**  
   **Reason:** The client has a branch for `community:invite`, but the API does not currently emit that name for join; invites are covered by `joined` / `member_added` / `__wsInternal`. If you add a dedicated “invited to community” realtime path on the server, either emit `community:invite` or remove the unused client case.

4. **`dm:invite`**  
   **Reason:** Same as above: client supports it; server uses `conversation:*` names. Optional alignment only.

5. **Document cookie vs token for WS**  
   **Reason:** Avoids the assumption that cookies authenticate the WebSocket; today **token is required** on `/ws`.

## Related env documentation

See [`docs/env.md`](env.md) for `REALTIME_EVENT_ALIAS_FANOUT` and WebSocket tunables.
