import { create } from 'zustand';
import { api, invalidateApiCache } from '../lib/api';
import { wsManager } from '../lib/ws';
import { useAuthStore } from './authStore';

type Entity = Record<string, any>;
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
type ChatState = {
  communities: Entity[];
  activeCommunity: Entity | null;
  channels: Entity[];
  activeChannel: Entity | null;
  conversations: Entity[];
  activeConv: Entity | null;
  messages: Record<string, Entity[]>;
  presence: Record<string, PresenceStatus>;
  awayMessages: Record<string, string | null>;
  members: Entity[];
  searchResults: Entity[] | null;
  searchQuery: string;
  searchFilters: SearchFilters;
  fetchCommunities: () => Promise<Entity[]>;
  createCommunity: (slug: string, name: string, description: string) => Promise<Entity>;
  deleteCommunity: (communityId: string) => Promise<void>;
  leaveCommunity: (communityId: string) => Promise<void>;
  selectCommunity: (community: Entity) => Promise<void>;
  fetchChannels: (communityId: string) => Promise<Entity[]>;
  fetchChannelMembers: (channelId: string) => Promise<Entity[]>;
  createChannel: (communityId: string, name: string, isPrivate?: boolean, description?: string) => Promise<Entity>;
  inviteToChannel: (channelId: string, userIds: string[]) => Promise<Entity[]>;
  deleteChannel: (channelId: string) => Promise<void>;
  selectChannel: (channel: Entity) => Promise<void>;
  fetchConversations: () => Promise<void>;
  openHome: () => void;
  openDm: (participants: string | string[]) => Promise<Entity>;
  selectConversation: (conv: Entity) => Promise<void>;
  inviteToConversation: (conversationId: string, participants: string[]) => Promise<Entity | null>;
  leaveConversation: (conversationId: string) => Promise<void>;
  renameGroupDm: (conversationId: string, name: string) => Promise<void>;
  fetchMessages: (args?: { channelId?: string; conversationId?: string; before?: string }) => Promise<Entity[]>;
  sendMessage: (content: string | SendMessageInput) => Promise<void>;
  editMessage: (id: string, content: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  fetchMembers: (communityId: string) => Promise<void>;
  hydratePresenceForUsers: (userIds: string[]) => Promise<void>;
  setPresence: (userId: string, status: PresenceStatus, awayMessage?: string | null) => void;
  search: (q: string, filters?: Partial<SearchFilters>) => Promise<void>;
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

function dedupeMessages(messages: Entity[]) {
  const deduped = [];
  const seen = new Set();

  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }

  return deduped;
}

function channelCommunityId(channel: Entity) {
  return channel?.community_id || channel?.communityId || null;
}

function upsertChannel(channels: Entity[], incoming: Entity) {
  if (!incoming?.id) return channels || [];
  const list = Array.isArray(channels) ? channels : [];
  const index = list.findIndex((channel) => channel.id === incoming.id);
  if (index === -1) return [...list, incoming];

  const next = [...list];
  next[index] = { ...next[index], ...incoming };
  return next;
}

function preserveRecentLocalChannels(serverChannels: Entity[], existingChannels: Entity[], communityId: string) {
  const merged = Array.isArray(serverChannels) ? [...serverChannels] : [];
  const seen = new Set(merged.map((channel) => channel?.id).filter(Boolean));
  const now = Date.now();

  for (const channel of Array.isArray(existingChannels) ? existingChannels : []) {
    if (!channel?.id || seen.has(channel.id)) continue;
    if (channelCommunityId(channel) !== communityId) continue;
    const localCreatedAt = Number(channel._localCreatedAt || 0);
    if (!localCreatedAt || now - localCreatedAt > 15_000) continue;
    merged.push(channel);
    seen.add(channel.id);
  }

  return merged;
}

function upsertMessage(messages, incoming) {
  const list = messages || [];
  const index = list.findIndex(message => message.id === incoming.id);
  if (index === -1) return [...list, incoming];

  const next = [...list];
  next[index] = { ...next[index], ...incoming };
  return next;
}

function hydrateAuthorFromSession(message: Entity) {
  if (!message || message.author) return message;

  const currentUser = useAuthStore.getState().user;
  if (!currentUser || message.author_id !== currentUser.id) return message;

  return {
    ...message,
    author: {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      display_name: currentUser.displayName,
      email: currentUser.email,
    },
  };
}

function channelLastMessageId(channel: Entity) {
  return channel?.last_message_id || channel?.lastMessageId || null;
}

function channelLastMessageAuthorId(channel: Entity) {
  return channel?.last_message_author_id || channel?.lastMessageAuthorId || null;
}

function channelMyLastReadMessageId(channel: Entity) {
  return channel?.my_last_read_message_id || channel?.myLastReadMessageId || null;
}

function isChannelUnreadForUser(channel: Entity, currentUserId?: string, activeChannelId?: string | null) {
  if (!channel || !currentUserId) return false;
  if (activeChannelId && channel.id === activeChannelId) return false;
  const lastMessageId = channelLastMessageId(channel);
  if (!lastMessageId) return false;
  if (channelLastMessageAuthorId(channel) === currentUserId) return false;
  return channelMyLastReadMessageId(channel) !== lastMessageId;
}

function countUnreadChannels(channels: Entity[], currentUserId?: string, activeChannelId?: string | null) {
  if (!currentUserId || !Array.isArray(channels)) return 0;
  return channels.reduce((count, channel) => count + (isChannelUnreadForUser(channel, currentUserId, activeChannelId) ? 1 : 0), 0);
}

function isVisibleConversation(conv: Entity, currentUserId?: string) {
  if (!conv) return false;
  if (!currentUserId) return true;
  if (conv.is_group) return true;
  const participants = Array.isArray(conv.participants) ? conv.participants : [];
  return participants.some((participant: Entity) => participant?.id && participant.id !== currentUserId);
}

function removeCommunityState(state: ChatState, communityId: string) {
  const removedChannelIds = state.channels
    .filter((channel) => (channel.community_id || channel.communityId) === communityId)
    .map((channel) => channel.id);
  const removedSet = new Set(removedChannelIds);
  const nextMessages = Object.fromEntries(
    Object.entries(state.messages).filter(([key]) => !removedSet.has(key))
  );
  const isActiveCommunity = state.activeCommunity?.id === communityId;
  const activeChannelRemoved = state.activeChannel?.id ? removedSet.has(state.activeChannel.id) : false;

  return {
    communities: state.communities.filter((community) => community.id !== communityId),
    activeCommunity: isActiveCommunity ? null : state.activeCommunity,
    channels: isActiveCommunity ? [] : state.channels,
    activeChannel: isActiveCommunity || activeChannelRemoved ? null : state.activeChannel,
    members: isActiveCommunity ? [] : state.members,
    messages: nextMessages,
  };
}

let unreadRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastUnreadRefreshAt = 0;
let communitiesInFlight: Promise<Entity[]> | null = null;
const channelsInFlightByCommunity = new Map<string, Promise<Entity[]>>();
let channelsFetchTokenCounter = 0;
const latestChannelsFetchTokenByCommunity = new Map<string, number>();
const readMarkInFlight = new Set<string>();
const readMarkRecent = new Map<string, number>();

const READ_MARK_RECENT_MS = 2000;
const UNREAD_REFRESH_MIN_MS = 1200;
let wsUserSubscriptionId: string | null = null;

function upsertConversation(conversations: Entity[], conversation: Entity) {
  const existing = conversations.find((conv) => conv.id === conversation.id);
  if (!existing) return [conversation, ...conversations];
  return conversations.map((conv) =>
    conv.id === conversation.id
      ? {
          ...conv,
          ...conversation,
          participants: conversation.participants || conv.participants,
        }
      : conv
  );
}

function ensureUserWsSubscription(handler: (event: any) => void) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId || wsUserSubscriptionId === userId) return;
  wsManager.subscribe(`user:${userId}`, handler);
  wsUserSubscriptionId = userId;
}

function normalizePresenceStatus(value: any): PresenceStatus {
  return VALID_PRESENCE_STATUSES.has(value) ? value : 'offline';
}

function normalizeSearchDateTime(value?: string | null) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function resolveSearchAuthorId(authorText: string, members: Entity[], activeConv: Entity | null) {
  const normalized = String(authorText || '').trim().toLowerCase();
  if (!normalized) return '';

  const candidates = activeConv
    ? (Array.isArray(activeConv.participants) ? activeConv.participants : [])
    : (Array.isArray(members) ? members : []);

  const exact = candidates.find((entry) => {
    const username = String(entry?.username || '').trim().toLowerCase();
    const displayName = String(entry?.displayName || entry?.display_name || '').trim().toLowerCase();
    return username === normalized || displayName === normalized;
  });

  if (exact?.id) return exact.id;

  const partial = candidates.find((entry) => {
    const username = String(entry?.username || '').trim().toLowerCase();
    const displayName = String(entry?.displayName || entry?.display_name || '').trim().toLowerCase();
    return username.includes(normalized) || displayName.includes(normalized);
  });

  return partial?.id || '';
}

function scheduleUnreadRefresh(run: () => void) {
  if (unreadRefreshTimer) return;
  const now = Date.now();
  const wait = Math.max(400, UNREAD_REFRESH_MIN_MS - (now - lastUnreadRefreshAt));
  unreadRefreshTimer = setTimeout(() => {
    unreadRefreshTimer = null;
    lastUnreadRefreshAt = Date.now();
    run();
  }, wait);
}

function markMessageRead(messageId?: string | null) {
  if (!messageId) return;
  const now = Date.now();
  const lastSentAt = readMarkRecent.get(messageId) || 0;
  if (readMarkInFlight.has(messageId) || now - lastSentAt < READ_MARK_RECENT_MS) {
    return;
  }

  readMarkRecent.set(messageId, now);
  readMarkInFlight.add(messageId);
  api.put(`/messages/${messageId}/read`)
    .catch(() => {})
    .finally(() => {
      readMarkInFlight.delete(messageId);
      if (readMarkRecent.size > 500) {
        const cutoff = Date.now() - READ_MARK_RECENT_MS;
        for (const [id, ts] of readMarkRecent) {
          if (ts < cutoff) readMarkRecent.delete(id);
        }
      }
    });
}

export function resetChatStore() {
  // Cancel any in-flight community fetch so the next user starts fresh.
  communitiesInFlight = null;
  channelsInFlightByCommunity.clear();
  readMarkInFlight.clear();
  readMarkRecent.clear();
  if (unreadRefreshTimer) {
    clearTimeout(unreadRefreshTimer);
    unreadRefreshTimer = null;
  }
  wsUserSubscriptionId = null;
  useChatStore.getState().reset();
}

export const useChatStore = create<ChatState>()((set, get) => ({
  // ── Data ──────────────────────────────────────────────────────────────────
  communities:     [],
  activeCommunity: null,
  channels:        [],
  activeChannel:   null,
  conversations:   [],
  activeConv:      null,
  messages:        {},   // { [channelId|convId]: Message[] }
  presence:        {},   // { [userId]: 'online'|'idle'|'away'|'offline' }
  awayMessages:    {},   // { [userId]: away message }
  members:         [],   // members of activeCommunity
  searchResults:   null,
  searchQuery:     '',
  searchFilters:   DEFAULT_SEARCH_FILTERS,

  reset() {
    set({
      communities:     [],
      activeCommunity: null,
      channels:        [],
      activeChannel:   null,
      conversations:   [],
      activeConv:      null,
      messages:        {},
      presence:        {},
      awayMessages:    {},
      members:         [],
      searchResults:   null,
      searchQuery:     '',
      searchFilters:   DEFAULT_SEARCH_FILTERS,
    });
  },

  // ── Communities ───────────────────────────────────────────────────────────
  async fetchCommunities() {
    ensureUserWsSubscription(get()._handleWsEvent);
    if (communitiesInFlight) return communitiesInFlight;

    communitiesInFlight = (async () => {
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
    const { community } = await api.post('/communities', { slug, name, description });
    invalidateApiCache('/communities');
    const created = {
      ...community,
      my_role: community?.my_role || 'owner',
      myRole: community?.myRole || 'owner',
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

  async selectCommunity(community: Entity) {
    set(s => ({
      activeCommunity: {
        ...community,
        has_new_activity: false,
        hasNewActivity: false,
      },
      communities: s.communities.map((c) =>
        c.id === community.id
          ? {
              ...c,
              has_new_activity: false,
              hasNewActivity: false,
            }
          : c
      ),
    }));
    const channelsPromise = get().fetchChannels(community.id);
    const membersPromise = get().fetchMembers(community.id);
    const channels = await channelsPromise;
    // Auto-select the first accessible channel as soon as channel data is ready.
    const firstAccessible = channels.find(ch => {
      const canAccess = ch?.can_access ?? ch?.canAccess ?? !ch?.is_private;
      return canAccess;
    });
    if (firstAccessible) {
      await get().selectChannel(firstAccessible);
    } else {
      set({ activeChannel: null, activeConv: null });
    }
    await membersPromise;
    // Subscribe to community-level events
    wsManager.subscribe(`community:${community.id}`, get()._handleWsEvent);
  },

  // ── Channels ──────────────────────────────────────────────────────────────
  async fetchChannels(communityId: string) {
    if (channelsInFlightByCommunity.has(communityId)) {
      return channelsInFlightByCommunity.get(communityId)!;
    }

    const requestToken = ++channelsFetchTokenCounter;
    latestChannelsFetchTokenByCommunity.set(communityId, requestToken);

    const inFlight = (async () => {
      const { channels } = await api.get(`/channels?communityId=${communityId}`);
      if (latestChannelsFetchTokenByCommunity.get(communityId) !== requestToken) {
        return channels;
      }
      set(s => {
        const mergedChannels = preserveRecentLocalChannels(channels || [], s.channels, communityId);
        return {
          channels: mergedChannels.map((channel: Entity) => {
            const previous = s.channels.find((ch: Entity) => ch.id === channel.id);
            const hadActivity = Boolean(previous?.has_new_activity ?? previous?.hasNewActivity);
            // Prefer the larger of: server-provided count vs in-memory incremented count
            const serverCount = channel.unread_message_count ?? 0;
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
          activeChannel: s.activeChannel
            ? (mergedChannels.find((ch: Entity) => ch.id === s.activeChannel?.id)
                ? {
                    ...(mergedChannels.find((ch: Entity) => ch.id === s.activeChannel?.id) as Entity),
                    has_new_activity: false,
                    hasNewActivity: false,
                    unread_message_count: 0,
                  }
                : s.activeChannel)
            : s.activeChannel,
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

    channelsInFlightByCommunity.set(communityId, inFlight);
    try {
      return await inFlight;
    } finally {
      channelsInFlightByCommunity.delete(communityId);
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
    await api.delete(`/channels/${channelId}`);
    set(s => {
      const { [channelId]: _removed, ...nextMessages } = s.messages;
      const isActive = s.activeChannel?.id === channelId;
      return {
        channels: s.channels.filter((channel) => channel.id !== channelId),
        activeChannel: isActive ? null : s.activeChannel,
        messages: nextMessages,
      };
    });
  },

  async selectChannel(channel: Entity) {
    const canAccess = channel?.can_access ?? channel?.canAccess ?? !channel?.is_private;
    if (!canAccess) return;

    set(s => ({
      activeChannel: {
        ...channel,
        has_new_activity: false,
        hasNewActivity: false,
        unread_message_count: 0,
      },
      activeConv: null,
      channels: s.channels.map((ch) =>
        ch.id === channel.id
          ? {
              ...ch,
              has_new_activity: false,
              hasNewActivity: false,
              unread_message_count: 0,
            }
          : ch
      ),
    }));
    await get().fetchMessages({ channelId: channel.id });
    // Subscribe to real-time events for this channel
    wsManager.subscribe(`channel:${channel.id}`, get()._handleWsEvent);
    // Mark latest message as read
    const msgs = get().messages[channel.id];
    if (msgs?.length) {
      const me = useAuthStore.getState().user;
      const lastId = msgs[msgs.length - 1].id;
      set(s => {
        const nextChannels = s.channels.map((ch) =>
          ch.id === channel.id
            ? {
                ...ch,
                my_last_read_message_id: lastId,
                myLastReadMessageId: lastId,
              }
            : ch
        );
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
      markMessageRead(lastId);
      scheduleUnreadRefresh(() => {
        const s = useChatStore.getState();
        s.fetchCommunities().catch(() => {});
        const communityId = channel.community_id || channel.communityId || s.activeCommunity?.id;
        if (communityId) {
          s.fetchChannels(communityId).catch(() => {});
        }
      });
    }
  },

  // ── Conversations (DMs) ───────────────────────────────────────────────────
  async fetchConversations() {
    ensureUserWsSubscription(get()._handleWsEvent);
    const { conversations } = await api.get('/conversations');
    const me = useAuthStore.getState().user;
    const visibleConversations = (conversations || []).filter((conv: Entity) => isVisibleConversation(conv, me?.id));
    set({ conversations: visibleConversations });
    visibleConversations.forEach((conv: Entity) => {
      if (conv?.id) {
        wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
      }
    });
  },

  openHome() {
    set({ activeCommunity: null, activeChannel: null });
  },

  async openDm(participants: string | string[]) {
    const list = Array.isArray(participants) ? participants : [participants];
    const cleaned = [...new Set((list || []).map((value) => value?.trim?.() || '').filter(Boolean))];
    if (!cleaned.length) {
      throw new Error('Select at least one participant');
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
      return {
        conversations: existing
          ? s.conversations.map(c => (c.id === conversation.id ? activeConv : c))
          : [activeConv, ...s.conversations],
        activeConv,
        activeChannel: null,
      };
    });
    await get().fetchMessages({ conversationId: conversation.id });
    wsManager.subscribe(`conversation:${conversation.id}`, get()._handleWsEvent);
    const msgs = get().messages[conversation.id];
    if (msgs?.length) {
      const lastId = msgs[msgs.length - 1].id;
      set(s => ({
        conversations: s.conversations.map((conv) =>
          conv.id === conversation.id
            ? {
                ...conv,
                my_last_read_message_id: lastId,
                myLastReadMessageId: lastId,
              }
            : conv
        ),
        activeConv:
          s.activeConv?.id === conversation.id
            ? {
                ...s.activeConv,
                my_last_read_message_id: lastId,
                myLastReadMessageId: lastId,
              }
            : s.activeConv,
      }));
      markMessageRead(lastId);
    }
    return conversation;
  },

  async selectConversation(conv: Entity) {
    set(s => ({
      activeConv: s.conversations.find((c) => c.id === conv.id) || conv,
      activeChannel: null,
    }));
    await get().fetchMessages({ conversationId: conv.id });
    wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
    const msgs = get().messages[conv.id];
    if (msgs?.length) {
      const lastId = msgs[msgs.length - 1].id;
      set(s => ({
        conversations: s.conversations.map((c) =>
          c.id === conv.id
            ? {
                ...c,
                my_last_read_message_id: lastId,
                myLastReadMessageId: lastId,
              }
            : c
        ),
        activeConv:
          s.activeConv?.id === conv.id
            ? {
                ...s.activeConv,
                my_last_read_message_id: lastId,
                myLastReadMessageId: lastId,
              }
            : s.activeConv,
      }));
      markMessageRead(lastId);
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
  async fetchMessages({ channelId, conversationId, before }: { channelId?: string; conversationId?: string; before?: string } = {}) {
    const key = channelId || conversationId;
    const qs  = new URLSearchParams();
    if (channelId)      qs.set('channelId',      channelId);
    if (conversationId) qs.set('conversationId', conversationId);
    if (before)         qs.set('before',         before);
    qs.set('limit', '50');

    const { messages } = await api.get(`/messages?${qs}`);
    set(s => ({
      messages: {
        ...s.messages,
        [key]: before
          ? dedupeMessages([...messages, ...(s.messages[key] || [])])
          : dedupeMessages(messages),
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
    if (activeChannel) body.channelId = activeChannel.id;
    if (activeConv) body.conversationId = activeConv.id;

    const { message } = await api.post('/messages', body);
    if (message?.id) {
      const key = message.channel_id || message.channelId || message.conversation_id || message.conversationId;
      if (key) {
        set((s) => ({
          messages: {
            ...s.messages,
            [key]: upsertMessage(s.messages[key], message),
          },
        }));
      }
      markMessageRead(message.id);
    }
  },

  async editMessage(id: string, content: string) {
    await api.patch(`/messages/${id}`, { content });
  },

  async deleteMessage(id: string) {
    await api.delete(`/messages/${id}`);
  },

  // ── Members ───────────────────────────────────────────────────────────────
  async fetchMembers(communityId: string) {
    const { members } = await api.get(`/communities/${communityId}/members`);
    set({ members });
    await get().hydratePresenceForUsers(
      (members || []).map((m: Entity) => String(m?.id || '')).filter(Boolean)
    );
  },

  async hydratePresenceForUsers(userIds: string[]) {
    const ids = Array.from(new Set((userIds || []).map((id) => String(id || '')).filter(Boolean)));
    if (!ids.length) return;

    const qs = encodeURIComponent(ids.join(','));
    const data = await api.get(`/presence?userIds=${qs}`);
    const presenceMap = data?.presence || {};
    const awayMap = data?.awayMessages || {};

    set((s) => {
      const nextPresence = { ...s.presence };
      const nextAwayMessages = { ...s.awayMessages };

      ids.forEach((id) => {
        const status = normalizePresenceStatus(presenceMap[id]);
        nextPresence[id] = status;
        nextAwayMessages[id] = status === 'away' ? (awayMap[id] ?? null) : null;
      });

      return {
        presence: nextPresence,
        awayMessages: nextAwayMessages,
      };
    });
  },

  // ── Presence ──────────────────────────────────────────────────────────────
  setPresence(userId: string, status: PresenceStatus, awayMessage: string | null = null) {
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

    set({ searchQuery: q, searchFilters: nextFilters });
    const normalizedQuery = String(q || '').trim();
    const after = normalizeSearchDateTime(nextFilters.after);
    const before = normalizeSearchDateTime(nextFilters.before);
    const { activeCommunity, activeConv, members } = get();
    const authorId = resolveSearchAuthorId(nextFilters.author, members, activeConv);
    const hasAnyFilter = Boolean(nextFilters.author.trim() || after || before);
    const canSearchText = normalizedQuery.length > 0;

    if (!canSearchText && !hasAnyFilter) {
      set({ searchResults: null });
      return;
    }

    if (nextFilters.author.trim() && !authorId) {
      set({ searchResults: [] });
      return;
    }

    const qs = new URLSearchParams({ limit: '30' });
    // Scope: community (all accessible channels) or DM conversation — per spec.
    if (activeConv)          qs.set('conversationId', activeConv.id);
    else if (activeCommunity) qs.set('communityId', activeCommunity.id);
    if (canSearchText) qs.set('q', normalizedQuery);
    if (authorId) qs.set('authorId', authorId);
    if (after) qs.set('after', after);
    if (before) qs.set('before', before);
    const results = await api.get(`/search?${qs}`);
    set({ searchResults: results.hits || [] });
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

  clearSearch() { set({ searchResults: null, searchQuery: '' }); },

  // ── WebSocket event handler ───────────────────────────────────────────────
  _handleWsEvent(event: any) {
    // Note: this is called as a standalone fn, not as a method, so use get()
    const store = useChatStore.getState();
    switch (event.event) {
      case 'message:created': {
        const msg = hydrateAuthorFromSession(event.data);
        const me = useAuthStore.getState().user;
        const key = msg.channel_id || msg.conversation_id;
        set(s => ({
          messages: {
            ...s.messages,
            [key]: upsertMessage(s.messages[key], msg),
          },
          channels: msg.channel_id
            ? s.channels.map((channel) => {
                if (channel.id !== msg.channel_id) return channel;
                const isActive = s.activeChannel?.id === msg.channel_id;
                return {
                  ...channel,
                  updated_at: msg.created_at || msg.createdAt || channel.updated_at,
                  updatedAt: msg.created_at || msg.createdAt || channel.updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at: msg.created_at || msg.createdAt || channel.last_message_at,
                  lastMessageAt: msg.created_at || msg.createdAt || channel.lastMessageAt,
                  has_new_activity: !isActive,
                  hasNewActivity: !isActive,
                  unread_message_count: isActive
                    ? 0
                    : (channel.unread_message_count ?? 0) + 1,
                };
              })
            : s.channels,
          activeChannel:
            msg.channel_id && s.activeChannel?.id === msg.channel_id
              ? {
                  ...s.activeChannel,
                  updated_at: msg.created_at || msg.createdAt || s.activeChannel.updated_at,
                  updatedAt: msg.created_at || msg.createdAt || s.activeChannel.updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at: msg.created_at || msg.createdAt || s.activeChannel.last_message_at,
                  lastMessageAt: msg.created_at || msg.createdAt || s.activeChannel.lastMessageAt,
                }
              : s.activeChannel,
          conversations: msg.conversation_id
            ? (() => {
                const next = [...s.conversations];
                const idx = next.findIndex(c => c.id === msg.conversation_id);
                if (idx === -1) return next;
                const updatedAt = msg.created_at || msg.createdAt || new Date().toISOString();
                const updated = {
                  ...next[idx],
                  updated_at: updatedAt,
                  updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at: updatedAt,
                  lastMessageAt: updatedAt,
                };
                next.splice(idx, 1);
                next.unshift(updated);
                return next;
              })()
            : s.conversations,
          activeConv:
            msg.conversation_id && s.activeConv?.id === msg.conversation_id
              ? {
                  ...s.activeConv,
                  updated_at: msg.created_at || msg.createdAt || s.activeConv.updated_at,
                  updatedAt: msg.created_at || msg.createdAt || s.activeConv.updatedAt,
                  last_message_id: msg.id,
                  lastMessageId: msg.id,
                  last_message_author_id: msg.author_id,
                  lastMessageAuthorId: msg.author_id,
                  last_message_at: msg.created_at || msg.createdAt || s.activeConv.last_message_at,
                  lastMessageAt: msg.created_at || msg.createdAt || s.activeConv.lastMessageAt,
                }
              : s.activeConv,
          communities: (() => {
            if (!msg.channel_id) return s.communities;
            const channelAfterUpdate = (msg.channel_id
              ? s.channels.map((channel) =>
                  channel.id === msg.channel_id
                    ? {
                        ...channel,
                        last_message_id: msg.id,
                        lastMessageId: msg.id,
                        last_message_author_id: msg.author_id,
                        lastMessageAuthorId: msg.author_id,
                        has_new_activity: s.activeChannel?.id !== msg.channel_id,
                        hasNewActivity: s.activeChannel?.id !== msg.channel_id,
                      }
                    : channel
                )
              : s.channels);
            const target = channelAfterUpdate.find((channel) => channel.id === msg.channel_id);
            const communityId = target?.community_id || target?.communityId;
            if (!communityId) return s.communities;
            const unreadCount = countUnreadChannels(channelAfterUpdate, me?.id, s.activeChannel?.id);
            return s.communities.map((community) =>
              community.id === communityId
                ? {
                    ...community,
                    unread_channel_count: unreadCount,
                    unreadChannelCount: unreadCount,
                    has_unread_channels: unreadCount > 0,
                    hasUnreadChannels: unreadCount > 0,
                    has_new_activity: s.activeCommunity?.id !== communityId,
                    hasNewActivity: s.activeCommunity?.id !== communityId,
                  }
                : community
            );
          })(),
          activeCommunity: (() => {
            if (!msg.channel_id || !s.activeCommunity) return s.activeCommunity;
            const channelAfterUpdate = (msg.channel_id
              ? s.channels.map((channel) =>
                  channel.id === msg.channel_id
                    ? {
                        ...channel,
                        last_message_id: msg.id,
                        lastMessageId: msg.id,
                        last_message_author_id: msg.author_id,
                        lastMessageAuthorId: msg.author_id,
                        has_new_activity: s.activeChannel?.id !== msg.channel_id,
                        hasNewActivity: s.activeChannel?.id !== msg.channel_id,
                      }
                    : channel
                )
              : s.channels);
            const target = channelAfterUpdate.find((channel) => channel.id === msg.channel_id);
            const communityId = target?.community_id || target?.communityId;
            if (!communityId || s.activeCommunity.id !== communityId) return s.activeCommunity;
            const unreadCount = countUnreadChannels(channelAfterUpdate, me?.id, s.activeChannel?.id);
            return {
              ...s.activeCommunity,
              unread_channel_count: unreadCount,
              unreadChannelCount: unreadCount,
              has_unread_channels: unreadCount > 0,
              hasUnreadChannels: unreadCount > 0,
              has_new_activity: false,
              hasNewActivity: false,
            };
          })(),
        }));
        if (msg.channel_id && store.activeChannel?.id === msg.channel_id && msg.id) {
          set(s => {
            const nextChannels = s.channels.map((channel) =>
              channel.id === msg.channel_id
                ? {
                    ...channel,
                    my_last_read_message_id: msg.id,
                    myLastReadMessageId: msg.id,
                  }
                : channel
            );
            const target = nextChannels.find((channel) => channel.id === msg.channel_id);
            const communityId = target?.community_id || target?.communityId || s.activeCommunity?.id;
            const unreadCount = countUnreadChannels(nextChannels, me?.id, s.activeChannel?.id);
            return {
              channels: nextChannels,
              activeChannel:
                s.activeChannel?.id === msg.channel_id
                  ? {
                      ...s.activeChannel,
                      my_last_read_message_id: msg.id,
                      myLastReadMessageId: msg.id,
                      has_new_activity: false,
                      hasNewActivity: false,
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
          markMessageRead(msg.id);
        }
        if (msg.conversation_id && store.activeConv?.id === msg.conversation_id && msg.id) {
          set(s => ({
            conversations: s.conversations.map((conv) =>
              conv.id === msg.conversation_id
                ? {
                    ...conv,
                    my_last_read_message_id: msg.id,
                    myLastReadMessageId: msg.id,
                  }
                : conv
            ),
            activeConv:
              s.activeConv?.id === msg.conversation_id
                ? {
                    ...s.activeConv,
                    my_last_read_message_id: msg.id,
                    myLastReadMessageId: msg.id,
                  }
                : s.activeConv,
          }));
          markMessageRead(msg.id);
        }
        break;
      }
      case 'message:updated': {
        const msg = hydrateAuthorFromSession(event.data);
        const key = msg.channel_id || msg.conversation_id;
        set(s => ({
          messages: {
            ...s.messages,
            [key]: (s.messages[key] || []).map(m => m.id === msg.id ? msg : m),
          },
        }));
        break;
      }
      case 'message:deleted': {
        // Remove from all lists (we don't know which key without the full msg)
        const { id } = event.data;
        set(s => {
          const messages = {};
          for (const [k, msgs] of Object.entries(s.messages)) {
            messages[k] = msgs.filter(m => m.id !== id);
          }
          return { messages };
        });
        break;
      }
      case 'presence:updated': {
        const { userId, status, awayMessage } = event.data;
        store.setPresence(userId, status, awayMessage ?? null);
        const auth = useAuthStore.getState();
        if (auth.user?.id === userId) {
          auth.setUser({
            ...auth.user,
            status,
            awayMessage: status === 'away' ? (awayMessage ?? null) : null,
          });
        }
        break;
      }
      case 'read:updated': {
        const { channelId, conversationId, userId, lastReadMessageId, lastReadAt } = event.data || {};
        if (!userId || (!conversationId && !channelId)) break;
        const me = useAuthStore.getState().user;
        if (channelId && me?.id === userId) {
          set(s => {
            const nextChannels = s.channels.map((channel) =>
              channel.id === channelId
                ? {
                    ...channel,
                    my_last_read_message_id: lastReadMessageId,
                    myLastReadMessageId: lastReadMessageId,
                    my_last_read_at: lastReadAt,
                    myLastReadAt: lastReadAt,
                    unread_message_count: 0,
                  }
                : channel
            );
            const target = nextChannels.find((channel) => channel.id === channelId);
            const communityId = target?.community_id || target?.communityId || s.activeCommunity?.id;
            const unreadCount = countUnreadChannels(nextChannels, me?.id, s.activeChannel?.id);
            return {
              channels: nextChannels,
              activeChannel:
                s.activeChannel?.id === channelId
                  ? {
                      ...s.activeChannel,
                      my_last_read_message_id: lastReadMessageId,
                      myLastReadMessageId: lastReadMessageId,
                      my_last_read_at: lastReadAt,
                      myLastReadAt: lastReadAt,
                      unread_message_count: 0,
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
        }
        if (!conversationId) break;
        set(s => ({
          conversations: s.conversations.map((conv) => {
            if (conv.id !== conversationId) return conv;
            if (me?.id === userId) {
              return {
                ...conv,
                my_last_read_message_id: lastReadMessageId,
                myLastReadMessageId: lastReadMessageId,
                my_last_read_at: lastReadAt,
                myLastReadAt: lastReadAt,
              };
            }
            return {
              ...conv,
              other_last_read_message_id: lastReadMessageId,
              otherLastReadMessageId: lastReadMessageId,
              other_last_read_at: lastReadAt,
              otherLastReadAt: lastReadAt,
            };
          }),
          activeConv:
            s.activeConv?.id === conversationId
              ? (me?.id === userId
                  ? {
                      ...s.activeConv,
                      my_last_read_message_id: lastReadMessageId,
                      myLastReadMessageId: lastReadMessageId,
                      my_last_read_at: lastReadAt,
                      myLastReadAt: lastReadAt,
                    }
                  : {
                      ...s.activeConv,
                      other_last_read_message_id: lastReadMessageId,
                      otherLastReadMessageId: lastReadMessageId,
                      other_last_read_at: lastReadAt,
                      otherLastReadAt: lastReadAt,
                    })
              : s.activeConv,
        }));
        break;
      }
      case 'community:member_joined':
      case 'community:member_left': {
        const { communityId } = event.data;
        if (store.activeCommunity?.id === communityId) {
          store.fetchMembers(communityId);
        }
        break;
      }
      case 'community:deleted': {
        const { communityId } = event.data || {};
        if (!communityId) break;
        set((s) => removeCommunityState(s, communityId));
        break;
      }
      case 'channel:created': {
        const channel = event.data;
        if (!channel?.community_id && !channel?.communityId) break;
        const communityId = channel.community_id || channel.communityId;
        if (store.activeCommunity?.id === communityId) {
          set((s) => ({
            channels: upsertChannel(s.channels, {
              ...channel,
              _localCreatedAt: channel._localCreatedAt || Date.now(),
            }),
          }));
          setTimeout(() => {
            invalidateApiCache(`/channels?communityId=${communityId}`);
            store.fetchChannels(communityId).catch(() => {});
          }, 400);
        }
        break;
      }
      case 'channel:membership_updated': {
        const { communityId } = event.data || {};
        if (communityId && store.activeCommunity?.id === communityId) {
          invalidateApiCache(`/channels?communityId=${communityId}`);
          store.fetchChannels(communityId).catch(() => {});
        }
        break;
      }
      case 'community:channel_message': {
        const { communityId, channelId } = event.data || {};
        if (!communityId || !channelId) break;

        set(s => ({
          channels: s.channels.map((channel) =>
            channel.id === channelId
              ? {
                  ...channel,
                  has_new_activity: s.activeChannel?.id !== channelId,
                  hasNewActivity: s.activeChannel?.id !== channelId,
                }
              : channel
          ),
          communities: s.communities.map((community) =>
            community.id === communityId
              ? {
                  ...community,
                  has_unread_channels: true,
                  hasUnreadChannels: true,
                  unread_channel_count: Math.max(Number(community.unread_channel_count ?? community.unreadChannelCount ?? 0), 1),
                  unreadChannelCount: Math.max(Number(community.unread_channel_count ?? community.unreadChannelCount ?? 0), 1),
                  has_new_activity: s.activeCommunity?.id !== communityId,
                  hasNewActivity: s.activeCommunity?.id !== communityId,
                }
              : community
          ),
          activeCommunity:
            s.activeCommunity?.id === communityId
              ? {
                  ...s.activeCommunity,
                  has_unread_channels: true,
                  hasUnreadChannels: true,
                  unread_channel_count: Math.max(Number(s.activeCommunity.unread_channel_count ?? s.activeCommunity.unreadChannelCount ?? 0), 1),
                  unreadChannelCount: Math.max(Number(s.activeCommunity.unread_channel_count ?? s.activeCommunity.unreadChannelCount ?? 0), 1),
                  has_new_activity: false,
                  hasNewActivity: false,
                }
              : s.activeCommunity,
        }));

        break;
      }
      case 'conversation:invited': {
        const conversation = event.data?.conversation;
        const conversationId = event.data?.conversationId || conversation?.id;
        if (!conversationId) break;

        wsManager.subscribe(`conversation:${conversationId}`, store._handleWsEvent);

        if (!conversation) {
          store.fetchConversations().catch(() => {});
          break;
        }

        set((s) => {
          const existing = s.conversations.find((conv) => conv.id === conversationId);

          const updated = existing
            ? {
                ...existing,
                ...conversation,
                participants: conversation.participants || existing.participants,
              }
            : conversation;

          const conversations = existing
            ? s.conversations.map((conv) => (conv.id === conversationId ? updated : conv))
            : [updated, ...s.conversations];

          return {
            conversations,
            activeConv:
              s.activeConv?.id === conversationId
                ? {
                    ...s.activeConv,
                    ...updated,
                    participants: updated.participants || s.activeConv.participants,
                }
                : s.activeConv,
          };
        });
        break;
      }
      case 'conversation:participant_added': {
        const conversation = event.data?.conversation;
        const conversationId = event.data?.conversationId || conversation?.id;
        if (!conversationId) break;

        wsManager.subscribe(`conversation:${conversationId}`, store._handleWsEvent);

        if (!conversation) {
          store.fetchConversations().catch(() => {});
          break;
        }

        set((s) => {
          const existing = s.conversations.find((conv) => conv.id === conversationId);

          const updated = existing
            ? {
                ...existing,
                ...conversation,
                participants: conversation.participants || existing.participants,
              }
            : conversation;

          const conversations = existing
            ? s.conversations.map((conv) => (conv.id === conversationId ? updated : conv))
            : [updated, ...s.conversations];

          return {
            conversations,
            activeConv:
              s.activeConv?.id === conversationId
                ? {
                    ...s.activeConv,
                    ...updated,
                    participants: updated.participants || s.activeConv.participants,
                }
                : s.activeConv,
          };
        });
        break;
      }
      case 'conversation:updated': {
        const conversation = event.data?.conversation;
        const conversationId = event.data?.conversationId || conversation?.id;
        if (!conversationId || !conversation) break;
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, name: conversation.name } : c
          ),
          activeConv:
            s.activeConv?.id === conversationId
              ? { ...s.activeConv, name: conversation.name }
              : s.activeConv,
        }));
        break;
      }
      case 'conversation:participant_left': {
        const conversationId = event.data?.conversationId;
        const leftUserId = event.data?.leftUserId || event.data?.userId;
        const me = useAuthStore.getState().user;
        if (!conversationId || !leftUserId) break;

        if (me?.id === leftUserId) {
          set((s) => ({
            conversations: s.conversations.filter((conv) => conv.id !== conversationId),
            activeConv: s.activeConv?.id === conversationId ? null : s.activeConv,
            activeChannel: s.activeConv?.id === conversationId ? null : s.activeChannel,
          }));
          break;
        }

        set((s) => {
          const updatedParticipants = (
            s.conversations.find((conv) => conv.id === conversationId)?.participants || []
          ).filter((participant) => participant.id !== leftUserId);

          const otherParticipants = updatedParticipants.filter((p) => p.id !== me?.id);
          if (otherParticipants.length === 0 && !s.conversations.find((conv) => conv.id === conversationId)?.is_group) {
            return {
              conversations: s.conversations.filter((conv) => conv.id !== conversationId),
              activeConv: s.activeConv?.id === conversationId ? null : s.activeConv,
              activeChannel: s.activeConv?.id === conversationId ? null : s.activeChannel,
            };
          }

          return {
            conversations: s.conversations.map((conv) =>
              conv.id === conversationId
                ? { ...conv, participants: updatedParticipants }
                : conv
            ),
            activeConv:
              s.activeConv?.id === conversationId
                ? {
                    ...s.activeConv,
                    participants: updatedParticipants,
                  }
                : s.activeConv,
          };
        });
        break;
      }
    }
  },
}));
