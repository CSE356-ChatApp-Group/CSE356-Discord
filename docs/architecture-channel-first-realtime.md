# Target architecture: channel-first realtime delivery

This document defines the **end state** and the **incremental path** from today’s **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`** + blocking **`user:`** duplicates.

## 1. Target architecture (confirmed design)

| Layer | Role |
|-------|------|
| **Primary realtime** | Redis **`channel:<uuid>`** pub/sub → sockets that have subscribed to that logical channel. |
| **Bridge** | Redis **`user:<uuid>`** (userfeed shard) only for **reconnect / bootstrap / short window** where `channel:` delivery is not yet guaranteed. |
| **Pending replay** | **`ws:pending:user:*`** for **connected** or **recent-marker** users only (`realtimePending.ts`); full **capped** member list is offered, filter drops offline. |
| **Offline / long-off** | No realtime mailbox requirement; **Postgres history**, **unread/read state**, and **reconnect DB replay** remain authoritative. |

**Confirmed as the product direction:** YES — this matches scaling goals (fewer `PUBLISH` targets per message) while keeping grading recoverability via `channel:` + pending + replay.

## 2. Gap audit (current prod-shaped stack)

| Topic | Gap | Mitigation |
|-------|-----|------------|
| **`WS_AUTO_SUBSCRIBE_MODE=user_only`** | No automatic **`channel:`** subscribe at bootstrap; clients often rely on **`user:`** for `message:created`. | **Prereq code:** full-list **pending enqueue** + **`ws:recent_connect` refresh on `pong`** so `recent_connect` inline fanout can shrink without dropping connected users. **Optional env:** `WS_AUTO_SUBSCRIBE_MODE=messages` for true channel-primary (validate harness). |
| **Channel subscription before `ready`** | With **`messages`/`full`**, bootstrap subscribes before **`{event:"ready"}`**; with **`user_only`**, not applicable. | Either switch autosubscribe **or** document that **bridge + pending** must cover `user_only`. |
| **Recent marker refresh** | `ws:recent_connect` was connect-only → long sessions lost MGET fallback. | **Implemented:** `markWsRecentConnect` on **WebSocket `pong`**. |
| **Pending replay scope** | Previously, `recent_connect` enqueued only inline recent targets → connected `user_only` clients could miss pending. | **Implemented:** `pendingEnqueueTargets` = capped members; filter keeps active/recent. |
| **Replay latency** | DB replay bounded; overload can skip. | Watch **`ws_replay_query_duration_ms`**, **`ws_replay_fail_open_total`**, **`ws_reliable_delivery_latency_ms{path="replay"}`**; tune only with evidence. |
| **Grader `user:` dependency** | Harness may assume **`user:`** delivery. | Until autosubscribe is on, keep **blocking** fanout + bridge; canary compares delivery before shrinking **`user:`** publishes. |

## 3. Prerequisites (implementation checklist)

- [x] **Pending:** `enqueuePendingMessageForUsers` uses **capped member list**, not only `recent_connect` inline targets (`channelRealtimeFanout.ts`).
- [x] **Pong:** refresh **`ws:recent_connect`** (`server.ts`).
- [x] **Reconnect:** existing **`replayMissedMessagesToSocket`** + **`replayPendingMessagesToSocket`** before **`ready`** (unchanged).
- [x] **Metrics:** **`ws_reliable_delivery_topic_total{path,topic_prefix}`** on reliable `ws.send` (split **`channel:`** vs **`user:`** vs other prefixes).
- [ ] **Prod env:** no change until **Stage B** (see rollout doc).

## 4. Rollout stages & gates

See **`docs/plan-recent-connect-rollout.md`** for **Stages A–D**, Prometheus comparisons, and abort rules.

**Gates (all must hold or roll back the stage):**

- **`delivery_timeout_total`** — no sustained increase vs baseline.
- **Grader / SLO** — delivery p95/mean does not worsen (external or synthetic).
- **`realtime_success_rate`** (derived from **`ws_reliable_delivery_total`**) — stable or up.
- **Replay fallback** — no spike in **`ws_reliable_delivery_total{path="replay"}`** share.
- **Cost** — **`redis_commands_per_request`** (or proxy), **CPU per 1k RPS**, **`fanout_publish_duration_ms`**, **`nodejs_eventloop_lag_p99`** improve or stay flat.
- **Redis memory** — bounded; watch **`ws_pending_replay_guard_total`**, evictions.

## 5. If `recent_connect` fails

1. **Identify path:** **`ws_reliable_delivery_topic_total`** (channel vs user), **`pending_replay_recipient_total`**, **`realtime_miss_attribution_total`**, logs with **`requestId`**.
2. **Fix:** autosubscribe, bridge TTL, inline union for connected SCARD, or replay admission — **evidence-led**.
3. **Do not** adopt “optimize **`all`**” as the long-term architecture **unless** channel-first is **proven impossible** after targeted fixes.

## 6. Report template (after each stage)

- **Target architecture confirmed:** YES (this doc) / NO  
- **Prerequisites complete:** YES / NO (see §3 checkboxes)  
- **`recent_connect` safe for workload:** YES / NO  
- **Cost reduction:** (numbers or “not measured”)  
- **Delivery impact:** (flat / better / worse + which metric)  
- **Next rollout stage:** A / B / C / D / hold  
