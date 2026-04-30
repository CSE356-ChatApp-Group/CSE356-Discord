import type { Entity, MessagePaginationState } from './chatStoreTypes';

type MessageScope = {
  messages: Record<string, Entity[]>;
  messagePagination: Record<string, MessagePaginationState>;
};

export function shouldFetchLatestMessages(state: MessageScope, key?: string | null) {
  if (!key) return true;
  const loadedMessages = state.messages[key];
  if (!Array.isArray(loadedMessages) || loadedMessages.length === 0) {
    return true;
  }

  const pagination = state.messagePagination[key];
  if (!pagination) return true;
  return Boolean(pagination.hasNewer);
}

/** Only mark read / advance my_last_read when the loaded history includes the channel tail (no newer pages). */
export function loadedHistoryIncludesLatest(
  state: Pick<MessageScope, 'messagePagination'>,
  key?: string | null,
) {
  if (!key) return false;
  return !state.messagePagination[key]?.hasNewer;
}
