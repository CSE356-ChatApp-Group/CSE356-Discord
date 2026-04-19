# Remove `channels.last_message_*` From Write Hot Path

## Why

Today every successful channel `POST /messages` eventually schedules a denormalized
`UPDATE channels SET last_message_* = ...`. That keeps list endpoints cheap, but it
also makes the `channels` row a shared contention point with:

- `messages.channel_id -> channels(id)` foreign-key validation
- deferred FK validation at `COMMIT`
- repoint work after message deletes

The result under production load is mixed latency on `POST /messages`:

- some requests stall in the access-check + insert CTE
- some requests stall at `COMMIT`

Longer term, we should stop touching the `channels` row on message create and serve
last-message metadata from Redis/cache-backed read models instead.

## Proposed Scope

Estimated implementation effort:

- 8-14 hours of careful implementation
- 1.5-2.5 days elapsed including rollout validation and regression testing

Primary changes:

- stop scheduling `scheduleChannelLastMessagePointerUpdate(...)` on channel message create
- stop relying on `channels.last_message_id`, `channels.last_message_author_id`, and
  `channels.last_message_at` for channel/community list reads
- maintain channel last-message metadata in Redis (or another cache/read model)
  using message create/delete events
- keep delete/repoint behavior correct when the latest message disappears

## Files Likely To Change

- `backend/src/messages/router.ts`
- `backend/src/messages/repointLastMessage.ts`
- `backend/src/messages/messageIngestLog.ts`
- `backend/src/channels/router.ts`
- `backend/src/communities/router.ts`
- likely a new helper such as `backend/src/messages/channelLastMessageCache.ts`
- possibly `backend/src/utils/metrics.ts` for cache hit/miss and rebuild visibility

## Functional Work

1. Write path

- remove channel last-message pointer updates from the message-create hot path
- update delete/repoint paths so cache state stays correct when the newest message is removed

2. Read path

- replace `GET /api/v1/channels` reads of `channels.last_message_*`
- replace `GET /api/v1/communities/:id` channel detail reads of `channels.last_message_*`
- replace community unread-count logic that currently depends on `ch.last_message_id`
  and `ch.last_message_author_id`

3. Cache lifecycle

- populate on message create
- repair on message delete / repoint
- handle cache misses with a bounded rebuild path from `messages`
- invalidate on channel delete / community delete
- define fail-open behavior when Redis is unavailable

## Tests Needed

- channel list returns correct last-message metadata after a new message
- channel list returns correct metadata after deleting the newest message
- community detail returns correct channel last-message metadata
- unread indicator/count still behaves correctly for:
  - self-authored latest message
  - another user's latest message
  - cache miss / rebuild cases
- delete/repoint race regression test
- Redis unavailable fallback test
- concurrency test showing channel-row lock contention is removed from the channel send hot path

## Success Criteria

- no `channels` row update on the normal channel message-create path
- materially lower `POST /messages` tail latency under grader load
- no correctness regressions in channel lists, community detail, or unread behavior
