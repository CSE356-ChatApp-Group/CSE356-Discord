/**
 * Serialize POST /messages DB transactions per channel_id on this Node process.
 *
 * Hot channels see concurrent INSERTs updating the same btree/GIN index pages
 * (notably btree_gin on (channel_id, content_tsv)), which can push insert-phase
 * wall time to the statement_timeout. Serializing removes same-channel overlap.
 */

'use strict';

const tail = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` immediately when `channelId` is null (DM path). For channel posts,
 * chains `fn` after prior same-channel work on this worker completes (success or failure).
 */
export function runChannelMessageInsertSerialized<T>(
  channelId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!channelId) return fn();

  const prev = tail.get(channelId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn) as Promise<T>;
  tail.set(channelId, next);
  return next.finally(() => {
    if (tail.get(channelId) === next) tail.delete(channelId);
  });
}
