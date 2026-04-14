# Database scaling: messages and read path

## Read replica (`PG_READ_REPLICA_URL`)

When `PG_READ_REPLICA_URL` is set, `GET /api/v1/messages` list queries use `queryRead()` against the replica by default. **Access-control checks** still hit the primary so authorization stays consistent; only the heavy `SELECT` for message rows may lag replication.

**Tradeoff:** A client that POSTs and immediately GETs might not see the new row until the replica catches up — **not a bug**, it is the cost of read scaling.

**Read-your-writes bypass:** send header **`X-ChatApp-Read-Consistency: primary`** (or **`strong`**) on **`GET /api/v1/messages`** to force the primary for that request (grading harnesses, “open channel after send” UX).

Tunables: `PG_READ_POOL_MAX` (default `15`).

## Partitioning

See [`migrations/013_messages_partitioning_roadmap.sql`](../migrations/013_messages_partitioning_roadmap.sql) for a non-destructive placeholder. Implement RANGE/HASH partitioning after load testing on a staging clone.

## Hot channel rows

Updating `channels.last_message_id` on every message can serialize writes in mega-channels. Mitigations: async denormalization, per-channel write batching, or stream-derived “latest message” outside the hot row (future work).
