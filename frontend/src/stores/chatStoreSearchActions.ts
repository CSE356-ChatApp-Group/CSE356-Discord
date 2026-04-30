import { api } from '../lib/api';
import { wsManager } from '../lib/ws';
import { dedupeMessages } from './chatStoreMessageList';
import { flushPendingReadForTarget } from './chatStoreReadReceipts';
import { normalizeSearchDateTime, resolveSearchAuthorId } from './chatStoreSearchHelpers';
import type { ChatState, ChatStoreGet, ChatStoreSet, Entity, SearchFilters } from './chatStoreTypes';
import { patchChannelRowById } from './chatStoreUnreadModel';

type ChatSearchSlice = Pick<
  ChatState,
  | 'search'
  | 'jumpToSearchResult'
  | 'clearJumpTargetMessage'
  | 'setSearchFilters'
  | 'resetSearchFilters'
  | 'clearSearch'
>;

export function createChatSearchActions(params: {
  get: ChatStoreGet;
  set: ChatStoreSet;
  messageContextSideLimit: number;
  defaultSearchFilters: SearchFilters;
}): ChatSearchSlice {
  const { get, set, messageContextSideLimit, defaultSearchFilters } = params;
  let latestSearchRequestSeq = 0;

  return {
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

      const context = await api.get(`/messages/context/${hit.id}?limit=${messageContextSideLimit}`);
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
      set({ searchFilters: defaultSearchFilters });
    },

    clearSearch() {
      set({ searchResults: null, searchQuery: '', searchError: null });
    },
  };
}
