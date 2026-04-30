import { create } from 'zustand';
import { api, getToken, invalidateApiCache } from '../lib/api';
import { wsManager } from '../lib/ws';
import { useAuthStore } from './authStore';
import type { Entity, MessagePaginationState, UnreadCountsSnapshot } from './chatStoreTypes';
export type {
  ChatStateCommunityRemovalSlice,
  Entity,
  MessagePaginationState,
  UnreadCountsSnapshot,
} from './chatStoreTypes';
import {
  dedupeMessages,
  mergeLatestPageWithExisting,
  sortMessagesChronologically,
  upsertMessageChronologically,
} from './chatStoreMessageList';
import {
  canAccessChannel,
  channelCommunityId,
  normalizeCommunityId,
  preserveRecentLocalChannels,
  requireCommunityId,
  upsertChannel,
} from './chatStoreChannelHelpers';
import { removeCommunityState } from './chatStoreCommunityRemoval';
import { loadedHistoryIncludesLatest, shouldFetchLatestMessages } from './chatStorePagination';
import {
  countUnreadChannels,
  entityAlreadyReadAtOrBeyond,
  isChannelUnreadForUser,
  isVisibleConversation,
  normalizeConversationUnreadMetadata,
  patchChannelRowById,
  patchConversationRowById,
} from './chatStoreUnreadModel';
import { createChatStoreWsHandler } from './chatStoreWsHandlers';
import {
  bindReadReceiptMessageLookup,
  flushAllPendingReadCoalesce,
  flushPendingReadForTarget,
  queueMarkMessageRead,
  resetReadReceiptState,
} from './chatStoreReadReceipts';
import { normalizeSearchDateTime, resolveSearchAuthorId } from './chatStoreSearchHelpers';
import { fetchUnreadCountsSnapshot } from './chatStoreUnreadCounts';
import { hydrateAuthorFromSession } from './chatStoreHydrate';
export const PRESENCE_STATUSES = ['online', 'idle', 'away', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
const VALID_PRESENCE_STATUSES = new Set<string>(PRESENCE_STATUSES);
type PendingUpload = {
  file: File;
  width?: number;
  height?: number;
};
type SendMessageInput = {
  content?: string;
  attachments?: PendingUpload[];
};
type SearchFilters = {
  author: string;
  after: string;
  before: string;
};
const MESSAGE_CONTEXT_SIDE_LIMIT = 25;
const MESSAGE_PAGE_LIMIT = 50;

type ChatState = {
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
  _handleWsEvent: (event: any) => void;
};

const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  author: '',
  after: '',
  before: '',
};

let latestSearchRequestSeq = 0;


let communitiesInFlight: Promise<Entity[]> | null = null;
const channelsInFlightByCommunity = new Map<string, Promise<Entity[]>>();
let channelsFetchTokenCounter = 0;
const latestChannelsFetchTokenByCommunity = new Map<string, number>();
const presenceFreshness = new Map<string, number>();
let presenceFreshnessSeq = 0;

let wsUserSubscriptionId: string | null = null;

/** After logout we skip one WS `open` so the fresh session does not double-fetch messages. */
let skipMessageRefetchOnNextWsOpen = true;

/** Throttle GET /messages after server WS bootstrap (`event: ready`) to heal missed realtime frames. */
const WS_SERVER_READY_REFETCH_MS = 1800;
let lastWsServerReadyRefetchAt = 0;

/** When returning to a visible tab, refetch the active pane (missed WS while backgrounded). */
const TAB_VISIBLE_MESSAGE_REFETCH_COOLDOWN_MS = 3000;
let lastTabVisibleMessageRefetchAt = 0;
const ACTIVE_MESSAGE_REFETCH_MIN_MS = 2000;
let lastActiveMessageRefetchAt = 0;
let activeMessageRefetchInFlight: Promise<void> | null = null;

function ensureUserWsSubscription(handler: (event: any) => void) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId || wsUserSubscriptionId === userId) return;
  wsManager.subscribe(`user:${userId}`, handler);
  wsUserSubscriptionId = userId;
}

function normalizePresenceStatus(value: any): PresenceStatus {
  return VALID_PRESENCE_STATUSES.has(value) ? value : 'offline';
}

export function resetChatStore() {
  // Cancel any in-flight community fetch so the next user starts fresh.
  communitiesInFlight = null;
  channelsInFlightByCommunity.clear();
  resetReadReceiptState();
  presenceFreshness.clear();
  presenceFreshnessSeq = 0;
  wsUserSubscriptionId = null;
  skipMessageRefetchOnNextWsOpen = true;
  lastWsServerReadyRefetchAt = 0;
  useChatStore.getState().reset();
}

export const useChatStore = create<ChatState>()((set, get) => {
  const _handleWsEvent = createChatStoreWsHandler(get, set);
  return ({
  // ── Data ──────────────────────────────────────────────────────────────────
  communities:     [],
  activeCommunity: null,
  channels:        [],
  activeChannel:   null,
  conversations:   [],
  activeConv:      null,
  messages:        {},   // { [channelId|convId]: Message[] }
  messagePagination: {},
  presence:        {},   // { [userId]: 'online'|'idle'|'away'|'offline' }
  awayMessages:    {},   // { [userId]: away message }
  members:         [],   // members of activeCommunity
  searchResults:   null,
  searchQuery:     '',
  searchError:     null,
  searchFilters:   DEFAULT_SEARCH_FILTERS,
  jumpTargetMessageId: null,

  reset() {
    presenceFreshness.clear();
    presenceFreshnessSeq = 0;
    set({
      communities:     [],
      activeCommunity: null,
      channels:        [],
      activeChannel:   null,
      conversations:   [],
      activeConv:      null,
      messages:        {},
      messagePagination: {},
      presence:        {},
      awayMessages:    {},
      members:         [],
      searchResults:   null,
      searchQuery:     '',
      searchError:     null,
      searchFilters:   DEFAULT_SEARCH_FILTERS,
      jumpTargetMessageId: null,
    });
  },

  // ── Communities ───────────────────────────────────────────────────────────
  async fetchCommunities() {
    ensureUserWsSubscription(get()._handleWsEvent);
    if (communitiesInFlight) return communitiesInFlight;

    communitiesInFlight = (async () => {
      invalidateApiCache('/communities');
      const { communities } = await api.get('/communities');
      set(s => ({
        communities: communities.map((community: Entity) => {
          const previous = s.communities.find((c: Entity) => c.id === community.id);
          const hadActivity = Boolean(previous?.has_new_activity ?? previous?.hasNewActivity);
          return hadActivity
            ? {
                ...community,
                has_new_activity: true,
                hasNewActivity: true,
              }
            : community;
        }),
        activeCommunity: s.activeCommunity
          ? (communities.find((c: Entity) => c.id === s.activeCommunity?.id)
              ? {
                  ...(communities.find((c: Entity) => c.id === s.activeCommunity?.id) as Entity),
                  has_new_activity: Boolean(s.activeCommunity?.has_new_activity ?? s.activeCommunity?.hasNewActivity),
                  hasNewActivity: Boolean(s.activeCommunity?.has_new_activity ?? s.activeCommunity?.hasNewActivity),
                }
              : s.activeCommunity)
          : s.activeCommunity,
      }));
      communities.forEach((community: Entity) => {
        if (community?.id && community?.my_role) {
          wsManager.subscribe(`community:${community.id}`, get()._handleWsEvent);
        }
      });
      // If a community was already active (e.g. after login without a page refresh),
      // re-fetch its channels so unread counts are up-to-date from the server.
      const activeCommunityId = get().activeCommunity?.id;
      if (activeCommunityId) {
        get().fetchChannels(activeCommunityId).catch(() => {});
      }
      return communities;
    })();

    try {
      return await communitiesInFlight;
    } finally {
      communitiesInFlight = null;
    }
  },

  async createCommunity(slug: string, name: string, description: string) {
    // Trailing slash avoids nginx 301 /communities → /communities/ on POST (301 drops body → GET list → missing id).
    const body = (await api.post('/communities/', { slug, name, description })) as Record<string, any>;
    invalidateApiCache('/communities');
    const inner =
      body?.community && typeof body.community === 'object' && !Array.isArray(body.community)
        ? body.community
        : {};
    const slugNorm = String(slug).trim();
    let id = normalizeCommunityId({ ...body, community: inner });
    // Older / proxied APIs may omit top-level id; slug is unique — recover from list after create.
    if (!id && slugNorm) {
      const list = await get().fetchCommunities();
      const found = list.find((c: Entity) => String(c.slug ?? '').trim() === slugNorm);
      if (found?.id) id = String(found.id).trim();
    }
    if (!id) {
      const err = new Error('Create community response missing id') as Error & { status?: number };
      err.status = 422;
      throw err;
    }
    const created = {
      ...inner,
      id,
      slug: inner.slug ?? slug,
      name: inner.name ?? name,
      description: inner.description ?? description,
      my_role: inner.my_role ?? inner.myRole ?? 'owner',
      myRole: inner.myRole ?? inner.my_role ?? 'owner',
    };
    set(s => ({ communities: [...s.communities, created] }));
    return created;
  },

  async deleteCommunity(communityId: string) {
    await api.delete(`/communities/${communityId}`);
    invalidateApiCache('/communities');
    set((s) => removeCommunityState(s, communityId));
  },

  async leaveCommunity(communityId: string) {
    await api.delete(`/communities/${communityId}/leave`);
    invalidateApiCache('/communities');
    set((s) => removeCommunityState(s, communityId));
  },

  async updateCommunityMemberRole(communityId: string, userId: string, role: 'member' | 'admin') {
    await api.patch(`/communities/${communityId}/members/${userId}`, { role });
    if (get().activeCommunity?.id === communityId) {
      await get().fetchMembers(communityId);
    }
    if (useAuthStore.getState().user?.id === userId) {
      await get().fetchCommunities();
    }
  },

  async selectCommunity(community: Entity) {
    const communityId = requireCommunityId(normalizeCommunityId(community), 'selectCommunity');
    const normalizedCommunity = {
      ...(community || {}),
      id: communityId,
      communityId,
      community_id: communityId,
    };
    const selectedCommunity =
      get().communities.find((existing) => existing.id === communityId) || normalizedCommunity;
    set(s => ({
      activeCommunity: {
        ...selectedCommunity,
        has_new_activity: false,
        hasNewActivity: false,
      },
      communities: s.communities.map((c) =>
        c.id === communityId
          ? {
              ...c,
              has_new_activity: false,
              hasNewActivity: false,
            }
          : c
      ),
    }));
    const channelsPromise = get().fetchChannels(communityId);
    const membersPromise = get().fetchMembers(communityId);
    const channels = await channelsPromise;
    // Auto-select the first accessible channel as soon as channel data is ready.
    const firstAccessible = channels.find(ch => {
      const canAccess = ch?.can_access ?? ch?.canAccess ?? !ch?.is_private;
      return canAccess;
    });
    if (firstAccessible) {
      await get().selectChannel(firstAccessible);
    } else {
      flushAllPendingReadCoalesce();
      set({ activeChannel: null, activeConv: null });
    }
    await membersPromise;
    // Subscribe to community-level events
    wsManager.subscribe(`community:${communityId}`, get()._handleWsEvent);
  },

  // ── Channels ──────────────────────────────────────────────────────────────
  async fetchChannels(communityId: string) {
    const normalizedCommunityId = requireCommunityId(communityId, 'fetchChannels');
    if (channelsInFlightByCommunity.has(normalizedCommunityId)) {
      return channelsInFlightByCommunity.get(normalizedCommunityId)!;
    }

    const requestToken = ++channelsFetchTokenCounter;
    latestChannelsFetchTokenByCommunity.set(normalizedCommunityId, requestToken);

    const inFlight = (async () => {
      invalidateApiCache(`/channels?communityId=${normalizedCommunityId}`);
      const [{ channels }, unreadSnapshot] = await Promise.all([
        api.get(`/channels?communityId=${normalizedCommunityId}`),
        fetchUnreadCountsSnapshot(),
      ]);
      if (latestChannelsFetchTokenByCommunity.get(normalizedCommunityId) !== requestToken) {
        return channels;
      }
      set(s => {
        const activeChannelInCommunity =
          s.activeChannel && channelCommunityId(s.activeChannel) === normalizedCommunityId;
        const mergedChannels = preserveRecentLocalChannels(channels || [], s.channels, normalizedCommunityId);
        const refreshedActiveChannel = activeChannelInCommunity
          ? mergedChannels.find((ch: Entity) => ch.id === s.activeChannel?.id) || null
          : null;
        const nextActiveChannel = activeChannelInCommunity
          ? (canAccessChannel(refreshedActiveChannel)
              ? {
                  ...refreshedActiveChannel,
                  has_new_activity: false,
                  hasNewActivity: false,
                  unread_message_count: 0,
                }
              : null)
          : s.activeChannel;
        return {
          channels: mergedChannels.map((channel: Entity) => {
            const previous = s.channels.find((ch: Entity) => ch.id === channel.id);
            const hadActivity = Boolean(previous?.has_new_activity ?? previous?.hasNewActivity);
            // Prefer the larger of: server-provided count vs in-memory incremented count
            const endpointCount = unreadSnapshot.channelCounts.get(String(channel.id)) ?? 0;
            const serverCount = Math.max(Number(channel.unread_message_count ?? 0), endpointCount);
            const prevCount = previous?.unread_message_count ?? 0;
            const unreadCount = Math.max(serverCount, prevCount);
            return hadActivity
              ? {
                  ...channel,
                  has_new_activity: true,
                  hasNewActivity: true,
                  unread_message_count: unreadCount,
                }
              : {
                  ...channel,
                  unread_message_count: unreadCount,
                };
          }),
          activeChannel: nextActiveChannel,
        };
      });
      (channels || []).forEach((channel: Entity) => {
        const canAccess = channel?.can_access ?? channel?.canAccess ?? !channel?.is_private;
        if (channel?.id && canAccess) {
          wsManager.subscribe(`channel:${channel.id}`, get()._handleWsEvent);
        }
      });
      return channels;
    })();

    channelsInFlightByCommunity.set(normalizedCommunityId, inFlight);
    try {
      return await inFlight;
    } finally {
      channelsInFlightByCommunity.delete(normalizedCommunityId);
    }
  },

  async fetchChannelMembers(channelId: string) {
    const { members } = await api.get(`/channels/${channelId}/members`);
    return members || [];
  },

  async createChannel(communityId: string, name: string, isPrivate = false, description = '') {
    const { channel } = await api.post('/channels', { communityId, name, isPrivate, description });
    const createdChannel = {
      ...channel,
      _localCreatedAt: Date.now(),
    };
    invalidateApiCache(`/channels?communityId=${communityId}`);
    latestChannelsFetchTokenByCommunity.set(communityId, ++channelsFetchTokenCounter);
    set(s => ({
      channels: upsertChannel(s.channels, createdChannel),
    }));

    if (get().activeCommunity?.id === communityId) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        invalidateApiCache(`/channels?communityId=${communityId}`);
        const refreshed = await get().fetchChannels(communityId).catch(() => null);
        if (Array.isArray(refreshed) && refreshed.some((existing) => existing.id === channel.id)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }

    return channel;
  },

  async inviteToChannel(channelId: string, userIds: string[]) {
    const { members } = await api.post(`/channels/${channelId}/members`, { userIds });
    const communityId = get().activeCommunity?.id;
    if (communityId) {
      invalidateApiCache(`/channels?communityId=${communityId}`);
      await get().fetchChannels(communityId);
    }
    return members || [];
  },

  async deleteChannel(channelId: string) {
    flushPendingReadForTarget(`ch:${channelId}`);
    await api.delete(`/channels/${channelId}`);
    set(s => {
      const { [channelId]: _removed, ...nextMessages } = s.messages;
      const { [channelId]: _removedPagination, ...nextMessagePagination } = s.messagePagination;
      const isActive = s.activeChannel?.id === channelId;
      return {
        channels: s.channels.filter((channel) => channel.id !== channelId),
        activeChannel: isActive ? null : s.activeChannel,
        messages: nextMessages,
        messagePagination: nextMessagePagination,
      };
    });
  },

  async updateChannel(channelId: string, updates: { name?: string; description?: string; isPrivate?: boolean }) {
    const body: Record<string, unknown> = {};
    if (typeof updates.name === 'string') body.name = updates.name;
    if (typeof updates.description === 'string') body.description = updates.description;
    if (typeof updates.isPrivate === 'boolean') body.isPrivate = updates.isPrivate;

    const { channel } = await api.patch(`/channels/${channelId}`, body);
    const communityId = channel?.community_id || channel?.communityId || get().activeCommunity?.id;
    if (communityId) {
      invalidateApiCache(`/channels?communityId=${communityId}`);
      await get().fetchChannels(communityId);
    }
    if (channel?.id) {
      set((s) => ({
        channels: upsertChannel(s.channels, channel),
        activeChannel: s.activeChannel?.id === channel.id ? { ...s.activeChannel, ...channel } : s.activeChannel,
      }));
    }
    return channel;
  },

  async selectChannel(channel: Entity) {
    const canAccess = channel?.can_access ?? channel?.canAccess ?? !channel?.is_private;
    if (!canAccess) return;

    const prev = get();
    if (prev.activeConv?.id) {
      flushPendingReadForTarget(`dm:${prev.activeConv.id}`);
    }
    if (prev.activeChannel?.id && prev.activeChannel.id !== channel.id) {
      flushPendingReadForTarget(`ch:${prev.activeChannel.id}`);
    }

    set(s => ({
      activeChannel: {
        ...channel,
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      },
      activeConv: null,
      channels: patchChannelRowById(s.channels, channel.id, {
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      }),
    }));
    if (shouldFetchLatestMessages(get(), channel.id)) {
      await get().fetchMessages({ channelId: channel.id });
    }
    // Subscribe to real-time events for this channel
    wsManager.subscribe(`channel:${channel.id}`, get()._handleWsEvent);
    // Mark latest message as read
    const msgs = get().messages[channel.id];
    if (msgs?.length && loadedHistoryIncludesLatest(get(), channel.id)) {
      const channelState = get();
      const channelReadState =
        channelState.channels.find((c) => c.id === channel.id)
        || channelState.activeChannel
        || channel;
      const lastMessage = msgs[msgs.length - 1];
      const me = useAuthStore.getState().user;
      const lastId = lastMessage.id;
      const shouldSendRead = !entityAlreadyReadAtOrBeyond(channelReadState, msgs, lastId);
      set(s => {
        const nextChannels = patchChannelRowById(s.channels, channel.id, {
          my_last_read_message_id: lastId,
          myLastReadMessageId: lastId,
        });
        const communityId = channel.community_id || channel.communityId || s.activeCommunity?.id;
        const unreadCount = countUnreadChannels(nextChannels, me?.id, channel.id);
        return {
          channels: nextChannels,
          activeChannel:
            s.activeChannel?.id === channel.id
              ? {
                  ...s.activeChannel,
                  my_last_read_message_id: lastId,
                  myLastReadMessageId: lastId,
                }
              : s.activeChannel,
          communities: communityId
            ? s.communities.map((community) =>
                community.id === communityId
                  ? {
                      ...community,
                      unread_channel_count: unreadCount,
                      unreadChannelCount: unreadCount,
                      has_unread_channels: unreadCount > 0,
                      hasUnreadChannels: unreadCount > 0,
                    }
                  : community
              )
            : s.communities,
          activeCommunity:
            communityId && s.activeCommunity?.id === communityId
              ? {
                  ...s.activeCommunity,
                  unread_channel_count: unreadCount,
                  unreadChannelCount: unreadCount,
                  has_unread_channels: unreadCount > 0,
                  hasUnreadChannels: unreadCount > 0,
                }
              : s.activeCommunity,
        };
      });
      if (shouldSendRead) {
        queueMarkMessageRead(lastId, {
          channelId: channel.id,
          coalesce: false,
          messageCreatedAt: lastMessage.created_at || lastMessage.createdAt,
        });
      }
    }
  },

  // ── Conversations (DMs) ───────────────────────────────────────────────────
  async fetchConversations() {
    ensureUserWsSubscription(get()._handleWsEvent);
    invalidateApiCache('/conversations');
    const [{ conversations }, unreadSnapshot] = await Promise.all([
      api.get('/conversations'),
      fetchUnreadCountsSnapshot(),
    ]);
    const me = useAuthStore.getState().user;
    const visibleConversations = (conversations || []).filter((conv: Entity) => isVisibleConversation(conv, me?.id));
    set((s) => ({
      conversations: visibleConversations.map((conversation: Entity) => {
        const previous = s.conversations.find((existing: Entity) => existing.id === conversation.id);
        const endpointCount = unreadSnapshot.conversationCounts.get(String(conversation.id)) ?? 0;
        const normalized = normalizeConversationUnreadMetadata({
          ...conversation,
          unread_message_count: Math.max(Number(conversation.unread_message_count ?? 0), endpointCount),
          has_new_activity: endpointCount > 0
            ? true
            : Boolean(conversation.has_new_activity ?? conversation.hasNewActivity),
          hasNewActivity: endpointCount > 0
            ? true
            : Boolean(conversation.hasNewActivity ?? conversation.has_new_activity),
        }, me?.id);
        if (!previous) return normalized;
        const hadActivity = Boolean(previous?.has_new_activity ?? previous?.hasNewActivity);
        const unreadCount = Math.max(
          Number(normalized.unread_message_count ?? 0),
          Number(previous?.unread_message_count ?? 0),
        );
        return hadActivity
          ? {
              ...normalized,
              has_new_activity: true,
              hasNewActivity: true,
              unread_message_count: unreadCount,
            }
          : {
              ...normalized,
              unread_message_count: unreadCount,
            };
      }),
    }));
    visibleConversations.forEach((conv: Entity) => {
      if (conv?.id) {
        wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
      }
    });
  },

  openHome() {
    flushAllPendingReadCoalesce();
    set({ activeCommunity: null, activeChannel: null });
  },

  async openDm(participants: string | string[]) {
    const list = Array.isArray(participants) ? participants : [participants];
    const cleaned = [...new Set((list || []).map((value) => value?.trim?.() || '').filter(Boolean))];
    if (!cleaned.length) {
      throw new Error('Select at least one participant');
    }

    const beforeOpen = get();
    if (beforeOpen.activeChannel?.id) {
      flushPendingReadForTarget(`ch:${beforeOpen.activeChannel.id}`);
    }
    if (beforeOpen.activeConv?.id) {
      flushPendingReadForTarget(`dm:${beforeOpen.activeConv.id}`);
    }

    const { conversation } = await api.post('/conversations', { participantIds: cleaned });
    set(s => {
      const existing = s.conversations.find(c => c.id === conversation.id);
      const activeConv = existing
        ? {
            ...conversation,
            ...existing,
            participants: conversation.participants || existing.participants,
          }
        : conversation;
      const clearedActiveConv = {
        ...activeConv,
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      };
      return {
        conversations: existing
          ? s.conversations.map(c => (c.id === conversation.id ? clearedActiveConv : c))
          : [clearedActiveConv, ...s.conversations],
        activeConv: clearedActiveConv,
        activeChannel: null,
      };
    });
    if (shouldFetchLatestMessages(get(), conversation.id)) {
      await get().fetchMessages({ conversationId: conversation.id });
    }
    wsManager.subscribe(`conversation:${conversation.id}`, get()._handleWsEvent);
    const msgs = get().messages[conversation.id];
    if (msgs?.length && loadedHistoryIncludesLatest(get(), conversation.id)) {
      const conversationState = get();
      const conversationReadState =
        conversationState.conversations.find((c) => c.id === conversation.id)
        || conversationState.activeConv
        || conversation;
      const lastMessage = msgs[msgs.length - 1];
      const lastId = lastMessage.id;
      const shouldSendRead = !entityAlreadyReadAtOrBeyond(conversationReadState, msgs, lastId);
      set(s => {
        const rowPatch = {
          my_last_read_message_id: lastId,
          myLastReadMessageId: lastId,
          has_new_activity: false,
          hasNewActivity: false,
          unread_message_count: 0,
        };
        return {
          conversations: patchConversationRowById(s.conversations, conversation.id, rowPatch),
          activeConv:
            s.activeConv?.id === conversation.id
              ? {
                  ...s.activeConv,
                  ...rowPatch,
                }
              : s.activeConv,
        };
      });
      if (shouldSendRead) {
        queueMarkMessageRead(lastId, {
          conversationId: conversation.id,
          coalesce: false,
          messageCreatedAt: lastMessage.created_at || lastMessage.createdAt,
        });
      }
    }
    return conversation;
  },

  async selectConversation(conv: Entity) {
    const preNav = get();
    if (preNav.activeChannel?.id) {
      flushPendingReadForTarget(`ch:${preNav.activeChannel.id}`);
    }
    if (preNav.activeConv?.id && preNav.activeConv.id !== conv.id) {
      flushPendingReadForTarget(`dm:${preNav.activeConv.id}`);
    }

    set(s => ({
      activeConv: {
        ...(s.conversations.find((c) => c.id === conv.id) || conv),
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      },
      activeChannel: null,
      conversations: patchConversationRowById(s.conversations, conv.id, {
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      }),
    }));
    if (shouldFetchLatestMessages(get(), conv.id)) {
      await get().fetchMessages({ conversationId: conv.id });
    }
    wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
    const msgs = get().messages[conv.id];
    if (msgs?.length && loadedHistoryIncludesLatest(get(), conv.id)) {
      const conversationState = get();
      const conversationReadState =
        conversationState.conversations.find((c) => c.id === conv.id)
        || conversationState.activeConv
        || conv;
      const lastMessage = msgs[msgs.length - 1];
      const lastId = lastMessage.id;
      const shouldSendRead = !entityAlreadyReadAtOrBeyond(conversationReadState, msgs, lastId);
      set(s => {
        const rowPatch = {
          my_last_read_message_id: lastId,
          myLastReadMessageId: lastId,
          has_new_activity: false,
          hasNewActivity: false,
          unread_message_count: 0,
        };
        return {
          conversations: patchConversationRowById(s.conversations, conv.id, rowPatch),
          activeConv:
            s.activeConv?.id === conv.id
              ? {
                  ...s.activeConv,
                  ...rowPatch,
                }
              : s.activeConv,
        };
      });
      if (shouldSendRead) {
        queueMarkMessageRead(lastId, {
          conversationId: conv.id,
          coalesce: false,
          messageCreatedAt: lastMessage.created_at || lastMessage.createdAt,
        });
      }
    }
  },

  async inviteToConversation(conversationId: string, participants: string[]) {
    const cleaned = (participants || []).map((value) => value.trim()).filter(Boolean);
    if (!conversationId || !cleaned.length) return null;

    const { conversation, createdNewConversation } = await api.post(
      `/conversations/${conversationId}/invite`,
      { participantIds: cleaned }
    );

    if (conversation?.id) {
      wsManager.subscribe(`conversation:${conversation.id}`, get()._handleWsEvent);
      const existingEntry = get().conversations.find((c) => c.id === conversation.id);

      if (!existingEntry) {
        // A new group DM was spun up from a 1-on-1 — add it to the list and
        // navigate the user directly into it.
        set(s => ({
          conversations: [conversation, ...s.conversations],
          ...(createdNewConversation && {
            activeConv: conversation,
            activeChannel: null,
          }),
        }));
        if (createdNewConversation) {
          await get().fetchMessages({ conversationId: conversation.id });
        }
      } else {
        // Existing group DM had a participant added — normal update path.
        set(s => ({
          conversations: s.conversations.map((conv) =>
            conv.id === conversation.id
              ? {
                  ...conv,
                  ...conversation,
                  participants: conversation.participants || conv.participants,
                }
              : conv
          ),
          activeConv:
            s.activeConv?.id === conversation.id
              ? {
                  ...s.activeConv,
                  ...conversation,
                  participants: conversation.participants || s.activeConv.participants,
                }
              : s.activeConv,
        }));
      }
    }

    return conversation || null;
  },

  async leaveConversation(conversationId: string) {
    flushPendingReadForTarget(`dm:${conversationId}`);
    try {
      await api.post(`/conversations/${conversationId}/leave`, {});
    } catch (err: any) {
      const status = Number(err?.status || 0);
      // Treat already-left/not-found as idempotent success for UI smoothness.
      if (status !== 403 && status !== 404) {
        throw err;
      }
    }

    set(s => ({
      conversations: s.conversations.filter((conv) => conv.id !== conversationId),
      activeConv: s.activeConv?.id === conversationId ? null : s.activeConv,
      activeChannel: s.activeConv?.id === conversationId ? null : s.activeChannel,
    }));
  },

  async renameGroupDm(conversationId: string, name: string) {
    const { conversation } = await api.patch(`/conversations/${conversationId}`, { name: name.trim() || null });
    set(s => ({
      conversations: s.conversations.map(c => c.id === conversationId ? { ...c, name: conversation.name } : c),
      activeConv: s.activeConv?.id === conversationId ? { ...s.activeConv, name: conversation.name } : s.activeConv,
    }));
  },

  // ── Messages ──────────────────────────────────────────────────────────────
  async fetchMessages({ channelId, conversationId, before, after }: { channelId?: string; conversationId?: string; before?: string; after?: string } = {}) {
    const key = channelId || conversationId;
    if (before && after) {
      throw new Error('Cannot page before and after at the same time');
    }
    const qs  = new URLSearchParams();
    if (channelId) qs.set('channelId', channelId);
    else if (conversationId) qs.set('conversationId', conversationId);
    if (before)         qs.set('before',         before);
    if (after)          qs.set('after',          after);
    qs.set('limit', String(MESSAGE_PAGE_LIMIT));

    if (!before && !after) {
      invalidateApiCache('/messages?');
    }

    const { messages } = await api.get(`/messages?${qs}`);
    set(s => ({
      messages: {
        ...s.messages,
        [key]: before
          ? dedupeMessages([...messages, ...(s.messages[key] || [])])
          : after
            ? dedupeMessages([...(s.messages[key] || []), ...messages])
            : mergeLatestPageWithExisting(s.messages[key], messages),
      },
      messagePagination: {
        ...s.messagePagination,
        [key]: before
          ? {
              ...(s.messagePagination[key] || { hasOlder: false, hasNewer: false }),
              hasOlder: messages.length === MESSAGE_PAGE_LIMIT,
            }
          : after
            ? {
                ...(s.messagePagination[key] || { hasOlder: false, hasNewer: false }),
                hasNewer: messages.length === MESSAGE_PAGE_LIMIT,
              }
            : {
                hasOlder: messages.length === MESSAGE_PAGE_LIMIT,
                hasNewer: false,
              },
      },
    }));
    return messages;
  },

  async sendMessage(content: string | SendMessageInput) {
    const { activeChannel, activeConv } = get();
    const payload = typeof content === 'string' ? { content } : (content || {});
    const trimmedContent = (payload.content || '').trim();
    const pendingUploads = Array.isArray(payload.attachments) ? payload.attachments : [];

    if (!activeChannel && !activeConv) {
      throw new Error('No active conversation selected');
    }

    if (!trimmedContent && pendingUploads.length === 0) {
      throw new Error('Message content or at least one image is required');
    }

    if (pendingUploads.length > 4) {
      throw new Error('You can attach up to 4 images');
    }

    const uploadedAttachments = await Promise.all(
      pendingUploads.map(async (attachment) => {
        const file = attachment.file;
        const presign = await api.post('/attachments/presign', {
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        });

        const uploadRes = await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          credentials: 'omit',
          cache: 'no-store',
          body: file,
        });

        if (!uploadRes.ok) {
          throw new Error(`Upload failed for ${file.name}`);
        }

        return {
          storageKey: presign.storageKey,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          width: attachment.width,
          height: attachment.height,
        };
      })
    );

    const body: { content?: string; attachments?: any[]; channelId?: string; conversationId?: string } = {};
    if (trimmedContent) body.content = trimmedContent;
    if (uploadedAttachments.length) body.attachments = uploadedAttachments;
    // Match server + GET /messages: never send both IDs (avoids ambiguous routing).
    if (activeChannel) body.channelId = activeChannel.id;
    else if (activeConv) body.conversationId = activeConv.id;

    const { message } = await api.post('/messages', body);
    if (message?.id) {
      const key = message.channel_id || message.channelId || message.conversation_id || message.conversationId;
      if (key) {
        const hydrated = hydrateAuthorFromSession(message);
        set((s) => ({
          messages: {
            ...s.messages,
            [key]: upsertMessageChronologically(s.messages[key], hydrated),
          },
        }));
      }
      const st = get();
      if (key && loadedHistoryIncludesLatest(st, key)) {
        queueMarkMessageRead(message.id, {
          channelId: message.channel_id || message.channelId || activeChannel?.id,
          conversationId: message.conversation_id || message.conversationId || activeConv?.id,
          coalesce: true,
          messageCreatedAt: message.created_at || message.createdAt,
        });
      }
    }
  },

  async editMessage(id: string, content: string) {
    const { message } = await api.patch(`/messages/${id}`, { content });
    if (!message?.id) return;
    const msg = hydrateAuthorFromSession(message);
    const key = msg.channel_id || msg.conversation_id;
    if (!key) return;
    set((s) => ({
      messages: {
        ...s.messages,
        [key]: (s.messages[key] || []).map((m) => (m.id === msg.id ? { ...m, ...msg } : m)),
      },
    }));
  },

  async deleteMessage(id: string) {
    await api.delete(`/messages/${id}`);
    set((s) => {
      const messages: Record<string, Entity[]> = {};
      for (const [k, msgs] of Object.entries(s.messages)) {
        messages[k] = msgs.filter((m) => m.id !== id);
      }
      return { messages };
    });
  },

  // ── Members ───────────────────────────────────────────────────────────────
  async fetchMembers(communityId: string) {
    const normalizedCommunityId = requireCommunityId(communityId, 'fetchMembers');
    const { members } = await api.get(`/communities/${normalizedCommunityId}/members`);
    set({ members });
    await get().hydratePresenceForUsers(
      (members || []).map((m: Entity) => String(m?.id || '')).filter(Boolean)
    );
  },

  async hydratePresenceForUsers(userIds: string[]) {
    const ids = Array.from(new Set((userIds || []).map((id) => String(id || '')).filter(Boolean)));
    if (!ids.length) return;

    const requestedAt = ++presenceFreshnessSeq;
    const data = await api.post('/presence/bulk', { userIds: ids });
    const presenceMap: Record<string, unknown> = data?.presence || {};
    const awayMap: Record<string, string | null> = data?.awayMessages || {};

    set((s) => {
      const nextPresence = { ...s.presence };
      const nextAwayMessages = { ...s.awayMessages };

      ids.forEach((id) => {
        if ((presenceFreshness.get(id) || 0) >= requestedAt) {
          return;
        }
        const status = normalizePresenceStatus(presenceMap[id]);
        nextPresence[id] = status;
        nextAwayMessages[id] = status === 'away' ? (awayMap[id] ?? null) : null;
        presenceFreshness.set(id, requestedAt);
      });

      return {
        presence: nextPresence,
        awayMessages: nextAwayMessages,
      };
    });
  },

  // ── Presence ──────────────────────────────────────────────────────────────
  setPresence(userId: string, status: PresenceStatus, awayMessage: string | null = null) {
    presenceFreshness.set(userId, ++presenceFreshnessSeq);
    set(s => ({
      presence: { ...s.presence, [userId]: normalizePresenceStatus(status) },
      awayMessages: {
        ...s.awayMessages,
        [userId]: normalizePresenceStatus(status) === 'away' ? (awayMessage || null) : null,
      },
    }));
  },

  // ── Search ────────────────────────────────────────────────────────────────
  async search(q: string, filters?: Partial<SearchFilters>) {
    const nextFilters = filters
      ? { ...get().searchFilters, ...filters }
      : get().searchFilters;

    const requestSeq = ++latestSearchRequestSeq;
    set({ searchQuery: q, searchFilters: nextFilters, searchError: null });
    const normalizedQuery = String(q || '').trim();
    const after = normalizeSearchDateTime(nextFilters.after);
    const before = normalizeSearchDateTime(nextFilters.before);
    const { activeCommunity, activeConv, members } = get();
    const authorId = resolveSearchAuthorId(nextFilters.author, members, activeConv);
    const hasAnyFilter = Boolean(nextFilters.author.trim() || after || before);
    const canSearchText = normalizedQuery.length > 0;

    if (!canSearchText && !hasAnyFilter) {
      if (requestSeq === latestSearchRequestSeq) {
        set({ searchResults: null, searchError: null });
      }
      return;
    }

    if (nextFilters.author.trim() && !authorId) {
      if (requestSeq === latestSearchRequestSeq) {
        set({ searchResults: [], searchError: null });
      }
      return;
    }

    const qs = new URLSearchParams({ limit: '30' });
    if (activeConv) qs.set('conversationId', activeConv.id);
    else if (activeCommunity) qs.set('communityId', activeCommunity.id);
    else {
      if (requestSeq === latestSearchRequestSeq) {
        set({ searchResults: [], searchError: 'Open a conversation or community before searching.' });
      }
      return;
    }
    if (canSearchText) qs.set('q', normalizedQuery);
    if (authorId) qs.set('authorId', authorId);
    if (after) qs.set('after', after);
    if (before) qs.set('before', before);
    try {
      const results = await api.get(`/search?${qs}`);
      if (requestSeq !== latestSearchRequestSeq) return;
      set({ searchResults: results.hits || [], searchError: null });
    } catch (err: any) {
      if (requestSeq !== latestSearchRequestSeq) return;
      set({
        searchResults: [],
        searchError: err?.message || 'Search failed. Please try again.',
      });
    }
  },

  async jumpToSearchResult(hit: Entity) {
    if (!hit?.id) return;

    const jumpNav = get();
    if (jumpNav.activeChannel?.id) {
      flushPendingReadForTarget(`ch:${jumpNav.activeChannel.id}`);
    }
    if (jumpNav.activeConv?.id) {
      flushPendingReadForTarget(`dm:${jumpNav.activeConv.id}`);
    }

    const context = await api.get(`/messages/context/${hit.id}?limit=${MESSAGE_CONTEXT_SIDE_LIMIT}`);
    const channelId = context.channelId || hit.channelId || hit.channel_id || null;
    const conversationId = context.conversationId || hit.conversationId || hit.conversation_id || null;
    const targetMessageId = context.targetMessageId || hit.id;
    const messages = dedupeMessages(Array.isArray(context.messages) ? context.messages : []);

    if (conversationId) {
      const currentState = get();
      const existingConversation = currentState.conversations.find((conversation) => conversation.id === conversationId)
        || (currentState.activeConv?.id === conversationId ? currentState.activeConv : null);
      const nextConversation = existingConversation || {
        id: conversationId,
        name: hit.conversationName || hit.conversation_name || currentState.activeConv?.name || 'Conversation',
        participants: currentState.activeConv?.id === conversationId ? currentState.activeConv?.participants : [],
      };

      wsManager.subscribe(`conversation:${conversationId}`, get()._handleWsEvent);
      set((s) => ({
      activeConv: nextConversation,
      activeChannel: null,
      messages: {
        ...s.messages,
        [conversationId]: messages,
      },
      messagePagination: {
        ...s.messagePagination,
        [conversationId]: {
          hasOlder: Boolean(context.hasOlder),
          hasNewer: Boolean(context.hasNewer),
        },
      },
      jumpTargetMessageId: targetMessageId,
      conversations: s.conversations.some((conversation) => conversation.id === conversationId)
          ? s.conversations.map((conversation) =>
              conversation.id === conversationId
                ? {
                    ...conversation,
                    ...nextConversation,
                    participants: nextConversation.participants || conversation.participants,
                  }
                : conversation
            )
          : [nextConversation, ...s.conversations],
      }));
      return;
    }

    if (!channelId) return;

    const currentState = get();
    const communityId = context.communityId || hit.communityId || hit.community_id || null;
    const nextCommunity = communityId
      ? currentState.communities.find((community) => community.id === communityId) || currentState.activeCommunity
      : currentState.activeCommunity;
    const existingChannel = currentState.channels.find((channel) => channel.id === channelId)
      || (currentState.activeChannel?.id === channelId ? currentState.activeChannel : null);
    const nextChannel = existingChannel || {
      id: channelId,
      name: hit.channelName || hit.channel_name || currentState.activeChannel?.name || 'channel',
      community_id: communityId || nextCommunity?.id || null,
      communityId: communityId || nextCommunity?.id || null,
    };

    wsManager.subscribe(`channel:${channelId}`, get()._handleWsEvent);
    set((s) => ({
      activeCommunity: nextCommunity || s.activeCommunity,
      activeChannel: {
        ...nextChannel,
        has_new_activity: false,
        hasNewActivity: false,
      },
      activeConv: null,
      messages: {
        ...s.messages,
        [channelId]: messages,
      },
      messagePagination: {
        ...s.messagePagination,
        [channelId]: {
          hasOlder: Boolean(context.hasOlder),
          hasNewer: Boolean(context.hasNewer),
        },
      },
      jumpTargetMessageId: targetMessageId,
      channels: patchChannelRowById(s.channels, channelId, {
        has_new_activity: false,
        hasNewActivity: false,
      }),
    }));
  },

  clearJumpTargetMessage() {
    set({ jumpTargetMessageId: null });
  },

  setSearchFilters(filters: Partial<SearchFilters>) {
    set((s) => ({
      searchFilters: {
        ...s.searchFilters,
        ...filters,
      },
    }));
  },

  resetSearchFilters() {
    set({ searchFilters: DEFAULT_SEARCH_FILTERS });
  },

  clearSearch() { set({ searchResults: null, searchQuery: '', searchError: null }); },

  // ── WebSocket event handler ───────────────────────────────────────────────
  _handleWsEvent,

});
});

bindReadReceiptMessageLookup((threadId) => useChatStore.getState().messages[threadId]);

wsManager.onOpen(() => {
  if (skipMessageRefetchOnNextWsOpen) {
    skipMessageRefetchOnNextWsOpen = false;
    return;
  }
  void refetchActiveMessagesIfStale();
});

wsManager.onServerReady(() => {
  const now = Date.now();
  if (now - lastWsServerReadyRefetchAt < WS_SERVER_READY_REFETCH_MS) return;
  lastWsServerReadyRefetchAt = now;
  void refetchActiveMessagesIfStale();
});

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!getToken()) return;
    const now = Date.now();
    if (now - lastTabVisibleMessageRefetchAt < TAB_VISIBLE_MESSAGE_REFETCH_COOLDOWN_MS) return;
    lastTabVisibleMessageRefetchAt = now;
    void refetchActiveMessagesIfStale();
  });
}

function refetchActiveMessagesIfStale(minIntervalMs = ACTIVE_MESSAGE_REFETCH_MIN_MS) {
  if (activeMessageRefetchInFlight) return activeMessageRefetchInFlight;
  const now = Date.now();
  if (now - lastActiveMessageRefetchAt < minIntervalMs) return Promise.resolve();
  const { activeChannel, activeConv, fetchMessages } = useChatStore.getState();
  if (!activeChannel?.id && !activeConv?.id) return Promise.resolve();
  lastActiveMessageRefetchAt = now;
  activeMessageRefetchInFlight = (async () => {
    if (activeChannel?.id) {
      await fetchMessages({ channelId: activeChannel.id });
    } else if (activeConv?.id) {
      await fetchMessages({ conversationId: activeConv.id });
    }
  })().catch(() => {}).finally(() => {
    activeMessageRefetchInFlight = null;
  });
  return activeMessageRefetchInFlight;
}
