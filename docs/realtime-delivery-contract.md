# Realtime delivery contract (server ↔ reference client)

This document is the **authoritative** contract between ChatApp’s WebSocket/Redis fanout and the in-repo reference client ([`docs/reference/generated-client-from-grader.ts`](./reference/generated-client-from-grader.ts)). Use it when debugging “delivery failures” vs HTTP **201** / **101** health.

## Connection and `ready`

- **URL:** `wss://<host>/ws?token=<accessToken>` (and cookies if the client sends them).
- **Server:** After auth, the process auto-subscribes the socket to **`user:<self>`** and, with default `WS_AUTO_SUBSCRIBE_MODE=messages`, hydrates **`channel:`** / **`conversation:`** topics the user may access, then emits **`event: "ready"`** with `data.bootstrapComplete` / `data.subscriptionsHydrated` only when **both** the initial bootstrap promise and subscription hydration complete ([`backend/src/websocket/server.ts`](../backend/src/websocket/server.ts)).
- **Reference client:** `enableRealtime()` resets readiness, opens the socket, then **`await waitForRealtimeReady()`** — readiness is set when a **`ready`** frame is handled (`markRealtimeReady()`). Internal **`__wsInternal.kind === "subscribe_channels"`** updates are only treated as DM/community “invites” **after** the client is ready, so the initial bootstrap list is not mistaken for a burst of new invites.

Staff dashboards that count “deliveries” may use a different probe (e.g. only certain topics or a stricter time anchor) than **HTTP 201** or **101**; correlate their definition to this contract before concluding the app is silent.

## `message:created` (channels and DMs)

### Event names the client accepts

- Primary: **`message:created`**
- Alias: **`new_message`**

### Minimum payload shape (`data`)

The reference client normalizes **`data`** with `mapMessage` and treats **`conversationId`** as the canonical routing key for delivery tracking. It accepts any of:

- `conversationId` / `conversation_id`
- `channelId` / `channel_id` (channel UUIDs are aliased into `conversationId`)

The message **id** and **author** fields must be present in one of the forms `mapMessage` understands (`id`, `authorId` / `author_id`, etc.) — see the reference file.

### Server publish paths (intentionally different)

| Target | Redis / logical topics | Implementation |
|--------|------------------------|------------------|
| **Channel** | `channel:<uuid>` first (unless `CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST=false`), then logical **`user:<member>`** duplicates via sharded **`userfeed:<n>`** (and optional community feed for public channels) | [`channelRealtimeFanout.ts`](../backend/src/messages/channelRealtimeFanout.ts) |
| **DM / group DM** | `conversation:<uuid>` and participant **`user:<id>`** via **`userfeed:<n>`** | [`publishConversationEventNow`](../backend/src/messages/router.ts) + [`conversationFanoutTargets.ts`](../backend/src/messages/conversationFanoutTargets.ts) |

Envelope for `message:*` includes **`publishedAt`** after Redis accepts the publish ([`realtimePayload.ts`](../backend/src/messages/realtimePayload.ts)). Do not publish raw `{ event, data }` for graded `message:*` paths without going through the same wrapper.

### HTTP **201** response flags

- **Channel:** `realtimeChannelFanoutComplete`, `realtimeUserFanoutDeferred` (depends on `MESSAGE_POST_SYNC_FANOUT`, `MESSAGE_USER_FANOUT_HTTP_BLOCKING`, queue depth).
- **Conversation:** `realtimeConversationFanoutComplete` (async enqueue may set **false** until the worker runs; fallback publish must still use the **full** conversation fanout, not a single-topic best-effort frame).

## Other events the reference client handles

- **Edits:** `message:updated`, `message:edited`, `message_edited`
- **Deletes:** `message:deleted`, `message_deleted` (plus `msg.channel` fallback `conversation:` / `channel:`)
- **Presence:** `presence:updated`, `presence_update`, `user:status`
- **Read receipts:** `read:updated`, `message:read`, `read:receipt`, `read_receipt` (requires channel or conversation id + user id)
- **Invites:** explicit conversation/community event names + post-ready `subscribe_channels` internal routing

## Related docs

- Course rubric alignment and “15s delivery” wording: [`GRADING-DELIVERY-SEMANTICS.md`](GRADING-DELIVERY-SEMANTICS.md)
- Operations / metrics: [`RUNBOOKS.md`](RUNBOOKS.md), [`operations-monitoring.md`](operations-monitoring.md)
