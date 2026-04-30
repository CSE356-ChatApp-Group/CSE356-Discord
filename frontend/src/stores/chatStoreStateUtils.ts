/** Generic keyed-state helpers for the chat store. */

export function removeKeyedState<T>(state: Record<string, T>, removedIds: Set<string>) {
  return Object.fromEntries(
    Object.entries(state || {}).filter(([key]) => !removedIds.has(key)),
  ) as Record<string, T>;
}
