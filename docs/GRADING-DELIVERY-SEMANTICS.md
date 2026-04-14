# Grading throughput: delivery success, failure, and outages

This page aligns the **course throughput / “Failed deliveries”** view with how ChatApp behaves, so you can separate **application bugs**, **harness timing**, and **capacity noise**.

## Definitions (course staff)

Per the optimization / throughput spec (as stated on the course forum):

- **Successful delivery:** Every community member who **should** receive a message gets it within **15 seconds** of the send. **Each listener counts as its own delivery** (N listeners ⇒ N delivery outcomes for that send).
- **Failed delivery:** At least one such listener does **not** receive that message within **15 seconds** (this can include the **sender** if the rubric counts them as a listener).
- **Outage:** In a sequence of **10 delivery events** or **30 seconds** (whichever framing the scoreboard uses), **more than 50%** of deliveries are failures — a burst rollup, not a single slow client.

The **grader’s implementation** of “should receive” may differ slightly from “anyone in the community”; see *Listener scope* below.

## How ChatApp exposes “delivery”

| Layer | What it means |
|--------|----------------|
| **HTTP `POST /api/v1/messages`** | Returns **201** after persist and the **configured** server-side publish steps. Response shape: **`realtimeChannelFanoutComplete`** + **`realtimeUserFanoutDeferred`** (channel posts) or **`realtimeConversationFanoutComplete`** (DMs) — not a single vague “fanout complete” flag. By default (`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`) the API **awaits** **`channel:<id>`** and each **`user:<uuid>`** duplicate (`realtimeUserFanoutDeferred: false`). When **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=false`**, the API awaits **`channel:<id>`** and enqueues **`user:`** publishes (`realtimeUserFanoutDeferred: true`). End-to-end browser delivery is still asynchronous. |
| **WebSocket** | Clients receive **`message:created`** on **`channel:<channelId>`** (and, for channel posts, on **`user:<userId>`** by default — see below). Automated probes usually treat the first matching WS frame within **15s** as success. |
| **HTTP `GET /messages?…`** | Strong way to assert persistence after **201**; not the same as the 15s **realtime** SLA unless the rubric says so. |

Flow (simplified): **Postgres insert** → **`fanout.publish` to Redis** → **each API node** delivers to its **local WS clients** ([`README.md`](../README.md) — Redis Pub/Sub Fanout).

### Channel posts: `user:<id>` fanout (default on)

For **public and private channels**, the server publishes **`message:created`** to **`channel:<id>`** first (unless `CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST=false`), then unless `CHANNEL_MESSAGE_USER_FANOUT=0`, to **up to `CHANNEL_MESSAGE_USER_FANOUT_MAX` eligible members’ `user:<uuid>`** topics ([`backend/src/messages/channelRealtimeFanout.ts`](../backend/src/messages/channelRealtimeFanout.ts)). **Beyond that cap**, only **`channel:`** receives the duplicate publish — clients must rely on **`channel:`** (or WebSocket autosubscribe there) for those members. Subscribers may therefore see the event on **`channel:`** before **`user:`** depending on Redis delivery order. Every connected client subscribes to **`user:<self>`** before the long **per-channel bootstrap** finishes ([`backend/src/websocket/server.ts`](../backend/src/websocket/server.ts)), so **throughput probes that open a WebSocket and POST before all `channel:` subscriptions complete** still see the event on the **user** topic. If a client explicitly **`unsubscribe`s** a `channel:<id>`, duplicate **`user:`** delivery for that channel’s **`message:*`** is suppressed for that socket so opt-out semantics stay correct. The web UI merges duplicates by **message id**; harness clients should do the same.

## Listener scope (confirm with rubric)

Our **Playwright** grader-shaped test assumes “should receive” means **users who have that channel open** (subscribed on the WebSocket), not merely “joined the community” on paper:

- [`frontend/e2e/delivery-fanout.spec.ts`](../frontend/e2e/delivery-fanout.spec.ts) — multiple browsers on the same public channel, **15s** window, documents this assumption in the file header.

With **default `user:`-topic fanout** for channel messages, any member who has completed the initial **`user:<self>`** WebSocket subscribe is a candidate to receive **`message:created`** without waiting for every **`channel:`** bootstrap subscription. If the official grader still disagrees with local counts, compare **listener scope** (e.g. only clients with an open WS) and **duplicate dedupe** on the harness side.

## Common patterns behind “sustained failed deliveries”

| Pattern | Likely cause |
|--------|----------------|
| Many **POST ≠ 201** | Mix of **403** (not allowed to post to private channel / not a participant) vs real failures. **403 is authorization, not “WS dropped the message”.** See **Course grader** in [`deploy/README.md`](../deploy/README.md). |
| **201** but WS miss | WS not connected, reconnect race, client too slow (**backpressure** — kill still drops), or harness waits only on a topic the client has not subscribed to yet (mitigated by default **`user:`** duplicate fanout for channel messages). |
| Intermittent misses under load | **Fanout queue backlog** or **overload** (presence/search throttling does not replace message fanout, but shared CPU/Redis/DB pressure does). |
| Everyone slow after ~same time | **Redis**, **Postgres pool**, or **API CPU** saturation; check Grafana / [`docs/RUNBOOKS.md`](RUNBOOKS.md) § *Grader-oriented delivery checks* and *Metrics during grader or load-test runs*. |
| Strict “after HTTP return” UI checks | For **`POST` / `PATCH` / `DELETE` on messages**, the API **awaits fanout** before success, so the UI can update right after success; other events may still prefer a short wait or **GET** (same Runbook section). |

## Load test mirror (optional)

[`load-tests/staging-capacity.js`](../load-tests/staging-capacity.js) — optional **`ws_message_delivery`** scenario: after **201**, time until **`message:created`** on the subscribed channel, **15s** SLA; counters **`optimization_ws_message_delivery_miss_total`**, trend **`message_ws_delivery_after_post_ms`**.

## Short answer you can post (forum-style)

> **Success:** Each expected listener gets the message within **15s** of send; **one failure** on any listener counts as a failed delivery for that send. **Outage:** **>50%** failures over **10 events** or **30s** (per course definition). **Our stack:** **201** means DB + **Redis fanout publish completed**; whether each **browser** counts as “received” within 15s is usually a **WebSocket `message:created`** observation. **403** on POST is **permission**, not delivery drop. For debugging sustained failures, correlate **fanout queue depth/delay**, **WS backpressure**, **POST status mix**, and overload — see repo **`docs/GRADING-DELIVERY-SEMANTICS.md`** and **`docs/RUNBOOKS.md`**.
