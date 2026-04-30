/** Shared types for chat store modules (keeps chatStore.ts slimmer). */

export type Entity = Record<string, any>;

export type MessagePaginationState = {
  hasOlder: boolean;
  hasNewer: boolean;
};
