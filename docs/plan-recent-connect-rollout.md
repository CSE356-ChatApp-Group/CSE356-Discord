# Incremental rollout: full `user:` fanout → channel-first (`recent_connect`)

Documentation hub: [`README.md`](README.md).

> Historical rollout plan: stages below describe the migration path. Current prod/staging target profile is git-tracked in [`deploy/env/prod.required.env`](../deploy/env/prod.required.env) and [`deploy/env/staging.required.env`](../deploy/env/staging.required.env).

Related design: [`docs/architecture-channel-first-realtime.md`](architecture-channel-first-realtime.md).

---

## Stage A — Code prerequisites only (no fanout mode change)

**Deploy:**

- `pendingEnqueueTargets` (full capped list → `enqueuePendingMessageForUsers`; inline `user:` still mode-dependent).
- `markWsRecentConnect` on WebSocket **`pong`**.
- **`ws_reliable_delivery_topic_total{path,topic_prefix}`** for delivery-path split.

**Env:** keep **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`**, **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`**.

**Verify:** no regression on **`delivery_timeout_total`**, **`ws_reliable_delivery_*`**, grader/synthetic delivery — **≥1 soak window** (your standard, e.g. 30–60 min peak slice).

**Gate to Stage B:** Stage A stable; owners sign off.

---

## Stage B — `recent_connect` on VM3 only

**Deploy:** per-host env on **VM3** only: `CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect`. VM1/VM2 remain **`all`**.

**Compare:** Prometheus `vm="vm3"` vs `vm=~"vm1|vm2"` — delivery, replay, fanout p99, Redis cmd/request, CPU/1k RPS.

**Abort if:** `delivery_timeout_total` up materially, grader p95 worse, **`realtime_success_rate`** down, replay fallback spike, or Redis memory / pending guard anomalies.

**Gate to Stage C:** **≥2h** (or your SLO window) stable under representative load.

---

## Stage C — ~50% fleet

Expand **`recent_connect`** to half of workers (e.g. VM2+VM3, or nginx weight plan from `docs/infrastructure-inventory.md`).

**Gate to Stage D:** same gates as B; cost metrics should show **Redis publish / cmd** pressure down vs Stage A baseline.

---

## Stage D — Full `recent_connect`

All app workers **`recent_connect`**; continue monitoring one full peak + business week.

**Long-term:** optionally move **`WS_AUTO_SUBSCRIBE_MODE`** toward **`messages`** so **`channel:`** is truly primary for more clients; validate harness first.

---

## Prometheus quick refs

| Question | PromQL / series |
|----------|-----------------|
| Realtime vs replay share | `sum(rate(ws_reliable_delivery_total{path="realtime"}[5m]))` vs `replay` |
| Delivery by topic | `sum by (topic_prefix) (rate(ws_reliable_delivery_topic_total{path="realtime"}[5m]))` |
| Channel vs user realtime | `topic_prefix=channel` vs `user` |
| Post-insert timeouts | `sum(rate(delivery_timeout_total[5m]))` |
| Fanout cost | `fanout_publish_duration_ms`, `fanout_publish_targets`, `channel_message_fanout_recipient_total` |

---

## Decision table

| Outcome | Action |
|---------|--------|
| Cost down, delivery flat | Next stage. |
| Delivery worse | Revert fanout mode on canary slice; file incident with metric diff; fix bridge/subscribe path — **not** “optimize `all`” as default long-term. |
| `user_only` still problematic | Try **Stage A +** staging test of `WS_AUTO_SUBSCRIBE_MODE=messages` before wider `recent_connect`. |

---

## Per-stage report (copy/paste)

- **Target architecture confirmed:** YES / NO  
- **Prerequisites complete:** YES / NO  
- **`recent_connect` safe:** YES / NO  
- **Cost reduction:**  
- **Delivery impact:**  
- **Next rollout stage:**  
