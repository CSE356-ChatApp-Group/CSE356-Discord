# WebSocket horizontal scale (design)

## Current shape

- Each API process runs a WebSocket server and subscribes to Redis Pub/Sub channels needed by its local sockets ([`backend/src/websocket/server.ts`](../backend/src/websocket/server.ts)).
- Channel `message:created` is published to Redis (`channel:<uuid>` and optionally `user:<uuid>` per member) from [`backend/src/messages/channelRealtimeFanout.ts`](../backend/src/messages/channelRealtimeFanout.ts).

## Scaling out

1. **More API/WS nodes:** Place N identical processes behind a TCP load balancer with **WebSocket-aware** configuration (sticky sessions optional; clients reconnect with JWT).
2. **Redis:** Use **Redis Cluster** or a managed Redis when Pub/Sub fan-in per process approaches CPU/network limits.
3. **Shard by user or channel:** Map `(userId % N)` or `(channelId % N)` to dedicated Redis clusters or dedicated subscriber pools to cap fan-in per instance (requires routing publishes).
4. **Streams / Kafka at the edge:** Replace per-message Redis Pub/Sub fanout with **consumer groups** where each WS shard reads only its partition (see `MESSAGE_INGEST_STREAM_*` hooks for a Redis Streams stepping stone).

## Sticky routing

- **Layer-4 LB:** Same IP may hit different nodes on reconnect; clients must resubscribe after `ready` (already the model).
- **Layer-7 / cookie stickiness:** Optional to keep long-lived debugging sessions on one node; not required if Redis is the shared bus.

## Observability

- `presence_fanout_recipients`, `ws_backpressure_events_total`, `ws_connection_result_total` — alert on sustained drops/kills before adding capacity.
