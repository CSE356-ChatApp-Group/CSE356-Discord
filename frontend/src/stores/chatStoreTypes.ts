/** Shared types for chat store modules (keeps chatStore.ts slimmer). */

import type { StoreApi } from 'zustand';

export type Entity = Record<string, any>;

export const PRESENCE_STATUSES = ['online', 'idle', 'away', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export type PendingUpload = {
  file: File;
  width?: number;
  height?: number;
};

export type SendMessageInput = {
  content?: string;
  attachments?: PendingUpload[];
};

export type SearchFilters = {
  author: string;
  after: string;
  before: string;
};

export type MessagePaginationState = {
  hasOlder: boolean;
  hasNewer: boolean;
};

/** Full Zustand chat store shape (data + actions). */
export type ChatState = {
  communities: Entity[];
  activeCommunity: Entity | null;
  channels: Entity[];
  activeChannel: Entity | null;
  conversations: Entity[];
  activeConv: Entity | null;
  messages: Record<string, Entity[]>;
  messagePagination: Record<string, MessagePaginationState>;
  presence: Record<string, PresenceStatus>;
  awayMessages: Record<string, string | null>;
  members: Entity[];
  searchResults: Entity[] | null;
  searchQuery: string;
  searchError: string | null;
  searchFilters: SearchFilters;
  jumpTargetMessageId: string | null;
  fetchCommunities: () => Promise<Entity[]>;
  createCommunity: (slug: string, name: string, description: string) => Promise<Entity>;
  deleteCommunity: (communityId: string) => Promise<void>;
  leaveCommunity: (communityId: string) => Promise<void>;
  updateCommunityMemberRole: (communityId: string, userId: string, role: 'member' | 'admin') => Promise<void>;
  selectCommunity: (community: Entity) => Promise<void>;
  fetchChannels: (communityId: string) => Promise<Entity[]>;
  fetchChannelMembers: (channelId: string) => Promise<Entity[]>;
  createChannel: (communityId: string, name: string, isPrivate?: boolean, description?: string) => Promise<Entity>;
  inviteToChannel: (channelId: string, userIds: string[]) => Promise<Entity[]>;
  deleteChannel: (channelId: string) => Promise<void>;
  updateChannel: (channelId: string, updates: { name?: string; description?: string; isPrivate?: boolean }) => Promise<Entity>;
  selectChannel: (channel: Entity) => Promise<void>;
  fetchConversations: () => Promise<void>;
  openHome: () => void;
  openDm: (participants: string | string[]) => Promise<Entity>;
  selectConversation: (conv: Entity) => Promise<void>;
  inviteToConversation: (conversationId: string, participants: string[]) => Promise<Entity | null>;
  leaveConversation: (conversationId: string) => Promise<void>;
  renameGroupDm: (conversationId: string, name: string) => Promise<void>;
  fetchMessages: (args?: { channelId?: string; conversationId?: string; before?: string; after?: string }) => Promise<Entity[]>;
  sendMessage: (content: string | SendMessageInput) => Promise<void>;
  editMessage: (id: string, content: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  fetchMembers: (communityId: string) => Promise<void>;
  hydratePresenceForUsers: (userIds: string[]) => Promise<void>;
  setPresence: (userId: string, status: PresenceStatus, awayMessage?: string | null) => void;
  search: (q: string, filters?: Partial<SearchFilters>) => Promise<void>;
  jumpToSearchResult: (hit: Entity) => Promise<void>;
  clearJumpTargetMessage: () => void;
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  resetSearchFilters: () => void;
  clearSearch: () => void;
  reset: () => void;
  _handleWsEvent: (event: unknown) => void;
};

type ChatStoreApi = StoreApi<ChatState>;
export type ChatStoreGet = ChatStoreApi['getState'];
export type ChatStoreSet = ChatStoreApi['setState'];

export type UnreadCountsSnapshot = {
  channelCounts: Map<string, number>;
  conversationCounts: Map<string, number>;
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
