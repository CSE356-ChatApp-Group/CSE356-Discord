/** Shared types for chat store modules (keeps chatStore.ts slimmer). */

export type Entity = Record<string, any>;

export type MessagePaginationState = {
  hasOlder: boolean;
  hasNewer: boolean;
};

/** Narrow slice used when stripping a community from local state. */
export type ChatStateCommunityRemovalSlice = {
  communities: Entity[];
  activeCommunity: Entity | null;
  channels: Entity[];
  activeChannel: Entity | null;
  members: Entity[];
  messages: Record<string, Entity[]>;
  messagePagination: Record<string, MessagePaginationState>;
};
