import { create } from 'zustand';
import { api, getToken, invalidateApiCache } from '../lib/api';
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
const MESSAGE_CONTEXT_SIDE_LIMIT = 25;
const MESSAGE_PAGE_LIMIT = 50;

type MessagePaginationState = {
  hasOlder: boolean;
  hasNewer: boolean;
};

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

/** Merge WS-hydrated rows with the latest GET page so opening a thread does not discard newer in-memory messages. */
function mergeLatestPageWithExisting(local: Entity[] | undefined, server: Entity[]): Entity[] {
  const map = new Map<string, Entity>();
  for (const message of local || []) {
    if (message?.id) map.set(String(message.id), message);
  }
  for (const message of server || []) {
    if (!message?.id) continue;
    const id = String(message.id);
    const prev = map.get(id);
    map.set(id, prev ? { ...prev, ...message } : message);
  }
  return sortMessagesChronologically(Array.from(map.values()));
}

function sortMessagesChronologically(messages: Entity[]): Entity[] {
  return [...messages].sort((a, b) => {
    const ta = new Date(a.created_at || a.createdAt || 0).getTime();
    const tb = new Date(b.created_at || b.createdAt || 0).getTime();
    const na = Number.isFinite(ta) ? ta : 0;
    const nb = Number.isFinite(tb) ? tb : 0;
    if (na !== nb) return na - nb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function messageSortKey(m: Entity): number {
  const t = new Date(m.created_at || m.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function compareMessageOrder(a: Entity, b: Entity): number {
  const na = messageSortKey(a);
  const nb = messageSortKey(b);
  if (na !== nb) return na - nb;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/** Upsert without full-array sort — hot path for WS + send ack (list stays chronologically sorted). */
function upsertMessageChronologically(existing: Entity[] | undefined, incoming: Entity): Entity[] {
  const list = Array.isArray(existing) ? existing : [];
  const idx = list.findIndex((m) => m.id === incoming.id);
  if (idx !== -1) {
    const next = [...list];
    next[idx] = { ...next[idx], ...incoming };
    return next;
  }
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (compareMessageOrder(incoming, list[mid]) <= 0) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const next = [...list];
  next.splice(lo, 0, incoming);
  return next;
}

function channelCommunityId(channel: Entity) {
  return channel?.community_id || channel?.communityId || null;
}

function normalizeCommunityId(input: any): string {
  const id = String(
    input?.id
      ?? input?.communityId
      ?? input?.community_id
      ?? input?.community?.id
      ?? input?.community?.communityId
      ?? input?.community?.community_id
      ?? input?.data?.id
      ?? '',
  ).trim();
  return id;
}

function requireCommunityId(id: string | null | undefined, action: string): string {
  const normalized = String(id ?? '').trim();
  if (!normalized) {
    throw new Error(`${action} requires a valid community id`);
  }
  return normalized;
}

function canAccessChannel(channel: Entity | null | undefined) {
  return Boolean(channel && (channel?.can_access ?? channel?.canAccess ?? !channel?.is_private));
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

function shouldFetchLatestMessages(state: Pick<ChatState, 'messages' | 'messagePagination'>, key?: string | null) {
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
function loadedHistoryIncludesLatest(state: Pick<ChatState, 'messagePagination'>, key?: string | null) {
  if (!key) return false;
  return !state.messagePagination[key]?.hasNewer;
}

function removeKeyedState<T>(state: Record<string, T>, removedIds: Set<string>) {
  return Object.fromEntries(
    Object.entries(state || {}).filter(([key]) => !removedIds.has(key))
  ) as Record<string, T>;
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

/** Immutable single-row patch by channel id; returns original ref if id not found. */
function patchChannelRowById(
  channels: Entity[],
  channelId: string,
  patch: Record<string, unknown>,
): Entity[] {
  const idx = channels.findIndex((c) => c.id === channelId);
  if (idx === -1) return channels;
  const next = [...channels];
  next[idx] = { ...next[idx], ...patch };
  return next;
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
  const nextMessages = removeKeyedState(state.messages, removedSet);
  const nextMessagePagination = removeKeyedState(state.messagePagination, removedSet);
  const isActiveCommunity = state.activeCommunity?.id === communityId;
  const activeChannelRemoved = state.activeChannel?.id ? removedSet.has(state.activeChannel.id) : false;

  return {
    communities: state.communities.filter((community) => community.id !== communityId),
    activeCommunity: isActiveCommunity ? null : state.activeCommunity,
    channels: isActiveCommunity ? [] : state.channels,
    activeChannel: isActiveCommunity || activeChannelRemoved ? null : state.activeChannel,
    members: isActiveCommunity ? [] : state.members,
    messages: nextMessages,
    messagePagination: nextMessagePagination,
  };
}

let communitiesInFlight: Promise<Entity[]> | null = null;
const channelsInFlightByCommunity = new Map<string, Promise<Entity[]>>();
let channelsFetchTokenCounter = 0;
const latestChannelsFetchTokenByCommunity = new Map<string, number>();
const readMarkInFlight = new Set<string>();
const readMarkRecent = new Map<string, number>();
const presenceFreshness = new Map<string, number>();
let presenceFreshnessSeq = 0;

/** Suppress duplicate PUTs for the same message id in a short window. */
const READ_MARK_RECENT_MS = 2000;
/** Coalesce live-tail read updates into one PUT per target per interval. */
const READ_COALESCE_MS = (() => {
  const raw = Number(import.meta.env.VITE_READ_COALESCE_MS);
  return Number.isFinite(raw) && raw > 200 ? Math.floor(raw) : 2500;
})();

const pendingReadByTarget = new Map<string, string>();
const readCoalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let readFlushVisibilityHooked = false;

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

function hookReadFlushOnVisibilityHidden() {
  if (readFlushVisibilityHooked || typeof document === 'undefined') return;
  readFlushVisibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAllPendingReadCoalesce();
    }
  });
}

function flushPendingReadForTarget(target: string) {
  const existingTimer = readCoalesceTimers.get(target);
  if (existingTimer) {
    clearTimeout(existingTimer);
    readCoalesceTimers.delete(target);
  }
  const messageId = pendingReadByTarget.get(target);
  if (!messageId) return;
  pendingReadByTarget.delete(target);
  emitMessageReadNow(messageId);
}

function flushAllPendingReadCoalesce() {
  const targets = new Set([...pendingReadByTarget.keys(), ...readCoalesceTimers.keys()]);
  for (const target of targets) {
    flushPendingReadForTarget(target);
  }
}

/**
 * @param coalesce When true, batch rapid updates (live message stream). When false, flush immediately (navigation).
 */
function queueMarkMessageRead(
  messageId: string | undefined | null,
  opts: { channelId?: string | null; conversationId?: string | null; coalesce?: boolean },
) {
  hookReadFlushOnVisibilityHidden();
  if (!messageId) return;
  const target =
    opts.channelId != null && opts.channelId !== ''
      ? `ch:${opts.channelId}`
      : opts.conversationId != null && opts.conversationId !== ''
        ? `dm:${opts.conversationId}`
        : null;
  if (!target) return;

  pendingReadByTarget.set(target, messageId);

  const existingTimer = readCoalesceTimers.get(target);
  if (existingTimer) clearTimeout(existingTimer);

  if (opts.coalesce) {
    readCoalesceTimers.set(
      target,
      setTimeout(() => flushPendingReadForTarget(target), READ_COALESCE_MS),
    );
  } else {
    flushPendingReadForTarget(target);
  }
}

function emitMessageReadNow(messageId?: string | null) {
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

  const exactUsername = candidates.find((entry) => {
    const username = String(entry?.username || '').trim().toLowerCase();
    return username === normalized;
  });

  return exactUsername?.id || '';
}

export function resetChatStore() {
  // Cancel any in-flight community fetch so the next user starts fresh.
  communitiesInFlight = null;
  channelsInFlightByCommunity.clear();
  readMarkInFlight.clear();
  readMarkRecent.clear();
  presenceFreshness.clear();
  presenceFreshnessSeq = 0;
  for (const t of readCoalesceTimers.values()) {
    clearTimeout(t);
  }
  readCoalesceTimers.clear();
  pendingReadByTarget.clear();
  wsUserSubscriptionId = null;
  skipMessageRefetchOnNextWsOpen = true;
  lastWsServerReadyRefetchAt = 0;
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
      const { channels } = await api.get(`/channels?communityId=${normalizedCommunityId}`);
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
      const me = useAuthStore.getState().user;
      const lastId = msgs[msgs.length - 1].id;
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
      queueMarkMessageRead(lastId, { channelId: channel.id, coalesce: false });
    }
  },

  // ── Conversations (DMs) ───────────────────────────────────────────────────
  async fetchConversations() {
    ensureUserWsSubscription(get()._handleWsEvent);
    invalidateApiCache('/conversations');
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
      return {
        conversations: existing
          ? s.conversations.map(c => (c.id === conversation.id ? activeConv : c))
          : [activeConv, ...s.conversations],
        activeConv,
        activeChannel: null,
      };
    });
    if (shouldFetchLatestMessages(get(), conversation.id)) {
      await get().fetchMessages({ conversationId: conversation.id });
    }
    wsManager.subscribe(`conversation:${conversation.id}`, get()._handleWsEvent);
    const msgs = get().messages[conversation.id];
    if (msgs?.length && loadedHistoryIncludesLatest(get(), conversation.id)) {
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
      queueMarkMessageRead(lastId, { conversationId: conversation.id, coalesce: false });
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
      activeConv: s.conversations.find((c) => c.id === conv.id) || conv,
      activeChannel: null,
    }));
    if (shouldFetchLatestMessages(get(), conv.id)) {
      await get().fetchMessages({ conversationId: conv.id });
    }
    wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
    const msgs = get().messages[conv.id];
    if (msgs?.length && loadedHistoryIncludesLatest(get(), conv.id)) {
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
      queueMarkMessageRead(lastId, { conversationId: conv.id, coalesce: false });
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
    const qs = encodeURIComponent(ids.join(','));
    const data = await api.get(`/presence?userIds=${qs}`);
    const presenceMap = data?.presence || {};
    const awayMap = data?.awayMessages || {};

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
    const { activeCommunity, activeChannel, activeConv, members } = get();
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
    else if (activeChannel) qs.set('channelId', activeChannel.id);
    else if (activeCommunity) qs.set('communityId', activeCommunity.id);
    else {
      if (requestSeq === latestSearchRequestSeq) {
        set({ searchResults: [], searchError: 'Open a channel, conversation, or community before searching.' });
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
  _handleWsEvent(event: any) {
    // Note: this is called as a standalone fn, not as a method, so use get()
      const store = useChatStore.getState();
    switch (event.event) {
      case 'message:created': {
        const msg = hydrateAuthorFromSession(event.data);
        const me = useAuthStore.getState().user;
        const key = msg.channel_id || msg.conversation_id;
        set((s) => {
          const paginationState = s.messagePagination[key];
          const existing = s.messages[key] || [];
          const nextMessages = {
            ...s.messages,
            [key]: upsertMessageChronologically(existing, msg),
          };

          let nextChannels = s.channels;
          let nextActiveChannel = s.activeChannel;
          let nextCommunities = s.communities;
          let nextActiveCommunity = s.activeCommunity;

          if (msg.channel_id) {
            const isViewingChannel = s.activeChannel?.id === msg.channel_id;
            const atLiveTail = Boolean(
              isViewingChannel && msg.id && !paginationState?.hasNewer,
            );
            const markReadInSamePass = atLiveTail;

            nextChannels = s.channels.map((channel) => {
              if (channel.id !== msg.channel_id) return channel;
              const isActive = s.activeChannel?.id === msg.channel_id;
              const row = {
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
                unread_message_count: atLiveTail && isActive
                  ? 0
                  : (channel.unread_message_count ?? 0) + 1,
              };
              if (!markReadInSamePass) return row;
              return {
                ...row,
                my_last_read_message_id: msg.id,
                myLastReadMessageId: msg.id,
                has_new_activity: false,
                hasNewActivity: false,
              };
            });

            nextActiveChannel =
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
                    ...(markReadInSamePass && msg.id
                      ? {
                          my_last_read_message_id: msg.id,
                          myLastReadMessageId: msg.id,
                          has_new_activity: false,
                          hasNewActivity: false,
                        }
                      : {}),
                  }
                : s.activeChannel;

            const targetCh = nextChannels.find((c) => c.id === msg.channel_id);
            const communityId = targetCh?.community_id || targetCh?.communityId;
            if (communityId) {
              const unreadCount = countUnreadChannels(nextChannels, me?.id, s.activeChannel?.id);
              nextCommunities = s.communities.map((community) =>
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
              if (s.activeCommunity?.id === communityId) {
                nextActiveCommunity = {
                  ...s.activeCommunity,
                  unread_channel_count: unreadCount,
                  unreadChannelCount: unreadCount,
                  has_unread_channels: unreadCount > 0,
                  hasUnreadChannels: unreadCount > 0,
                  has_new_activity: false,
                  hasNewActivity: false,
                };
              }
            }
          }

          let nextConversations = s.conversations;
          let nextActiveConv = s.activeConv;

          if (msg.conversation_id) {
            const next = [...s.conversations];
            const idx = next.findIndex((c) => c.id === msg.conversation_id);
            const viewingDm = s.activeConv?.id === msg.conversation_id;
            const dmAtLiveTail = Boolean(viewingDm && msg.id && !paginationState?.hasNewer);
            if (idx !== -1) {
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
                ...(dmAtLiveTail
                  ? {
                      my_last_read_message_id: msg.id,
                      myLastReadMessageId: msg.id,
                    }
                  : {}),
              };
              next.splice(idx, 1);
              next.unshift(updated);
              nextConversations = next;
            }
            nextActiveConv =
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
                    ...(dmAtLiveTail
                      ? {
                          my_last_read_message_id: msg.id,
                          myLastReadMessageId: msg.id,
                        }
                      : {}),
                  }
                : s.activeConv;
          }

          return {
            messages: nextMessages,
            channels: nextChannels,
            activeChannel: nextActiveChannel,
            conversations: nextConversations,
            activeConv: nextActiveConv,
            communities: nextCommunities,
            activeCommunity: nextActiveCommunity,
          };
        });

        const st = get();
        if (
          msg.channel_id
          && st.activeChannel?.id === msg.channel_id
          && msg.id
          && loadedHistoryIncludesLatest(st, msg.channel_id)
        ) {
          queueMarkMessageRead(msg.id, { channelId: msg.channel_id, coalesce: true });
        }
        if (
          msg.conversation_id
          && st.activeConv?.id === msg.conversation_id
          && msg.id
          && loadedHistoryIncludesLatest(st, msg.conversation_id)
        ) {
          queueMarkMessageRead(msg.id, { conversationId: msg.conversation_id, coalesce: true });
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
          const pre = get().channels.find((c) => c.id === channelId);
          const preCommunityId = channelCommunityId(pre || {});
          if (preCommunityId) {
            invalidateApiCache(`/channels?communityId=${preCommunityId}`);
          }
          set((s) => {
            const rowPatch = {
              my_last_read_message_id: lastReadMessageId,
              myLastReadMessageId: lastReadMessageId,
              my_last_read_at: lastReadAt,
              myLastReadAt: lastReadAt,
              unread_message_count: 0,
            };
            const idx = s.channels.findIndex((c) => c.id === channelId);
            const nextChannels =
              idx === -1 ? s.channels : patchChannelRowById(s.channels, channelId, rowPatch);
            const communityId =
              idx === -1
                ? (s.activeCommunity?.id ?? null)
                : (s.channels[idx].community_id || s.channels[idx].communityId || s.activeCommunity?.id);
            const unreadCount = countUnreadChannels(nextChannels, me?.id, s.activeChannel?.id);
            return {
              channels: nextChannels,
              activeChannel:
                s.activeChannel?.id === channelId
                  ? {
                      ...s.activeChannel,
                      ...rowPatch,
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
        set((s) => {
          const cidx = s.conversations.findIndex((c) => c.id === conversationId);
          if (cidx === -1) {
            return {
              conversations: s.conversations,
              activeConv: s.activeConv,
            };
          }
          const next = [...s.conversations];
          const base = next[cidx];
          next[cidx] =
            me?.id === userId
              ? {
                  ...base,
                  my_last_read_message_id: lastReadMessageId,
                  myLastReadMessageId: lastReadMessageId,
                  my_last_read_at: lastReadAt,
                  myLastReadAt: lastReadAt,
                }
              : {
                  ...base,
                  other_last_read_message_id: lastReadMessageId,
                  otherLastReadMessageId: lastReadMessageId,
                  other_last_read_at: lastReadAt,
                  otherLastReadAt: lastReadAt,
                };
          return {
            conversations: next,
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
          };
        });
        break;
      }
      case 'community:role_updated': {
        const { communityId, userId } = event.data || {};
        if (!communityId || !userId) break;
        if (store.activeCommunity?.id === communityId) {
          store.fetchMembers(communityId).catch(() => {});
        }
        if (useAuthStore.getState().user?.id === userId) {
          invalidateApiCache('/communities');
          store.fetchCommunities().catch(() => {});
        }
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
      case 'channel:updated': {
        const channel = event.data || {};
        const communityId = channel.community_id || channel.communityId;
        const channelId = channel.id;
        if (!communityId || !channelId) break;
        const explicitAccess = channel.can_access ?? channel.canAccess;
        set((s) => {
          const previousChannel = s.channels.find((existing) => existing.id === channelId);
          const previousAccess =
            previousChannel?.can_access
            ?? previousChannel?.canAccess
            ?? (!previousChannel?.is_private);
          const accessChanged = explicitAccess !== undefined && previousAccess !== explicitAccess;

          let nextMessages = s.messages;
          let nextPagination = s.messagePagination;
          if (accessChanged) {
            const { [channelId]: _removedMessages, ...restMessages } = s.messages;
            const { [channelId]: _removedPagination, ...restPagination } = s.messagePagination;
            nextMessages = restMessages;
            nextPagination = restPagination;
          }

          return {
            channels: upsertChannel(s.channels, {
              ...(previousChannel || {}),
              ...channel,
            }),
            activeChannel:
              s.activeChannel?.id === channelId
                ? (explicitAccess === false
                    ? null
                    : {
                        ...s.activeChannel,
                        ...channel,
                      })
                : s.activeChannel,
            messages: nextMessages,
            messagePagination: nextPagination,
          };
        });
        if (store.activeCommunity?.id === communityId) {
          invalidateApiCache(`/channels?communityId=${communityId}`);
          store.fetchChannels(communityId).catch(() => {});
        }
        break;
      }
      case 'channel:deleted': {
        const channelId = event.data?.id;
        const communityId = event.data?.community_id || event.data?.communityId;
        if (!channelId) break;
        set((s) => {
          const { [channelId]: _removed, ...nextMessages } = s.messages;
          const { [channelId]: _removedPagination, ...nextPagination } = s.messagePagination;
          return {
            channels: s.channels.filter((channel) => channel.id !== channelId),
            activeChannel: s.activeChannel?.id === channelId ? null : s.activeChannel,
            messages: nextMessages,
            messagePagination: nextPagination,
          };
        });
        if (communityId && store.activeCommunity?.id === communityId) {
          invalidateApiCache(`/channels?communityId=${communityId}`);
          store.fetchChannels(communityId).catch(() => {});
        }
        break;
      }
      case 'channel:membership_updated': {
        const { communityId, channelId } = event.data || {};
        if (channelId) {
          wsManager.subscribe(`channel:${channelId}`, get()._handleWsEvent);
        }
        if (communityId && store.activeCommunity?.id === communityId) {
          invalidateApiCache(`/channels?communityId=${communityId}`);
          store.fetchChannels(communityId).catch(() => {});
        }
        break;
      }
      case 'community:channel_message': {
        const { communityId, channelId } = event.data || {};
        if (!communityId || !channelId) break;

        set((s) => {
          const chIdx = s.channels.findIndex((c) => c.id === channelId);
          const coIdx = s.communities.findIndex((c) => c.id === communityId);
          const nextChannels =
            chIdx === -1
              ? s.channels
              : (() => {
                  const n = [...s.channels];
                  n[chIdx] = {
                    ...n[chIdx],
                    has_new_activity: s.activeChannel?.id !== channelId,
                    hasNewActivity: s.activeChannel?.id !== channelId,
                  };
                  return n;
                })();
          const nextCommunities =
            coIdx === -1
              ? s.communities
              : (() => {
                  const n = [...s.communities];
                  const prev = n[coIdx];
                  n[coIdx] = {
                    ...prev,
                    has_unread_channels: true,
                    hasUnreadChannels: true,
                    unread_channel_count: Math.max(
                      Number(prev.unread_channel_count ?? prev.unreadChannelCount ?? 0),
                      1,
                    ),
                    unreadChannelCount: Math.max(
                      Number(prev.unread_channel_count ?? prev.unreadChannelCount ?? 0),
                      1,
                    ),
                    has_new_activity: s.activeCommunity?.id !== communityId,
                    hasNewActivity: s.activeCommunity?.id !== communityId,
                  };
                  return n;
                })();
          return {
            channels: nextChannels,
            communities: nextCommunities,
            activeCommunity:
              s.activeCommunity?.id === communityId
                ? {
                    ...s.activeCommunity,
                    has_unread_channels: true,
                    hasUnreadChannels: true,
                    unread_channel_count: Math.max(
                      Number(
                        s.activeCommunity.unread_channel_count ?? s.activeCommunity.unreadChannelCount ?? 0,
                      ),
                      1,
                    ),
                    unreadChannelCount: Math.max(
                      Number(
                        s.activeCommunity.unread_channel_count ?? s.activeCommunity.unreadChannelCount ?? 0,
                      ),
                      1,
                    ),
                    has_new_activity: false,
                    hasNewActivity: false,
                  }
                : s.activeCommunity,
          };
        });

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
