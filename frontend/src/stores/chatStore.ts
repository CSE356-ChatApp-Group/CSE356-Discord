import { create } from 'zustand';
import { api } from '../lib/api';
import { wsManager } from '../lib/ws';
import { useAuthStore } from './authStore';

type Entity = Record<string, any>;
type PresenceStatus = 'online' | 'idle' | 'away' | 'offline';

type ChatState = {
  communities: Entity[];
  activeCommunity: Entity | null;
  channels: Entity[];
  activeChannel: Entity | null;
  conversations: Entity[];
  activeConv: Entity | null;
  messages: Record<string, Entity[]>;
  presence: Record<string, PresenceStatus>;
  members: Entity[];
  searchResults: Entity[] | null;
  searchQuery: string;
  fetchCommunities: () => Promise<Entity[]>;
  createCommunity: (slug: string, name: string, description: string) => Promise<Entity>;
  selectCommunity: (community: Entity) => Promise<void>;
  fetchChannels: (communityId: string) => Promise<Entity[]>;
  createChannel: (communityId: string, name: string, isPrivate?: boolean, description?: string) => Promise<Entity>;
  selectChannel: (channel: Entity) => Promise<void>;
  fetchConversations: () => Promise<void>;
  openHome: () => void;
  openDm: (userId: string) => Promise<Entity>;
  selectConversation: (conv: Entity) => Promise<void>;
  fetchMessages: (args?: { channelId?: string; conversationId?: string; before?: string }) => Promise<Entity[]>;
  sendMessage: (content: string) => Promise<void>;
  editMessage: (id: string, content: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  fetchMembers: (communityId: string) => Promise<void>;
  setPresence: (userId: string, status: PresenceStatus) => void;
  search: (q: string) => Promise<void>;
  clearSearch: () => void;
  _handleWsEvent: (event: any) => void;
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
  members:         [],   // members of activeCommunity
  searchResults:   null,
  searchQuery:     '',

  // ── Communities ───────────────────────────────────────────────────────────
  async fetchCommunities() {
    const { communities } = await api.get('/communities');
    set({ communities });
    return communities;
  },

  async createCommunity(slug: string, name: string, description: string) {
    const { community } = await api.post('/communities', { slug, name, description });
    set(s => ({ communities: [...s.communities, community] }));
    return community;
  },

  async selectCommunity(community: Entity) {
    set({ activeCommunity: community, activeChannel: null, activeConv: null });
    await get().fetchChannels(community.id);
    await get().fetchMembers(community.id);
    // Subscribe to community-level events
    wsManager.subscribe(`community:${community.id}`, get()._handleWsEvent);
  },

  // ── Channels ──────────────────────────────────────────────────────────────
  async fetchChannels(communityId: string) {
    const { channels } = await api.get(`/channels?communityId=${communityId}`);
    set({ channels });
    return channels;
  },

  async createChannel(communityId: string, name: string, isPrivate = false, description = '') {
    const { channel } = await api.post('/channels', { communityId, name, isPrivate, description });
    set(s => ({ channels: [...s.channels, channel] }));
    return channel;
  },

  async selectChannel(channel: Entity) {
    set({ activeChannel: channel, activeConv: null });
    await get().fetchMessages({ channelId: channel.id });
    // Subscribe to real-time events for this channel
    wsManager.subscribe(`channel:${channel.id}`, get()._handleWsEvent);
    // Mark latest message as read
    const msgs = get().messages[channel.id];
    if (msgs?.length) {
      api.put(`/messages/${msgs[msgs.length - 1].id}/read`).catch(() => {});
    }
  },

  // ── Conversations (DMs) ───────────────────────────────────────────────────
  async fetchConversations() {
    const { conversations } = await api.get('/conversations');
    set({ conversations });
    conversations.forEach((conv: Entity) => {
      if (conv?.id) {
        wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
      }
    });
  },

  openHome() {
    set({ activeCommunity: null, activeChannel: null });
  },

  async openDm(userId: string) {
    const { conversation } = await api.post('/conversations', { participantIds: [userId] });
    set(s => ({
      conversations: s.conversations.find(c => c.id === conversation.id)
        ? s.conversations
        : [conversation, ...s.conversations],
      activeConv: conversation,
      activeChannel: null,
    }));
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
      api.put(`/messages/${lastId}/read`).catch(() => {});
    }
    return conversation;
  },

  async selectConversation(conv: Entity) {
    set({ activeConv: conv, activeChannel: null });
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
      api.put(`/messages/${lastId}/read`).catch(() => {});
    }
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

  async sendMessage(content: string) {
    const { activeChannel, activeConv } = get();
    const body: { content: string; channelId?: string; conversationId?: string } = { content };
    if (activeChannel)  body.channelId      = activeChannel.id;
    if (activeConv)     body.conversationId = activeConv.id;
    const { message } = await api.post('/messages', body);
    // Mark the just-sent message as read immediately
    if (message?.id) {
      api.put(`/messages/${message.id}/read`).catch(() => {});
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
    // Seed presence map from member list
    const presence = {};
    members.forEach((m: Entity) => { presence[m.id] = m.status || 'offline'; });
    set({ members, presence: { ...get().presence, ...presence } });
  },

  // ── Presence ──────────────────────────────────────────────────────────────
  setPresence(userId: string, status: PresenceStatus) {
    set(s => ({ presence: { ...s.presence, [userId]: status } }));
  },

  // ── Search ────────────────────────────────────────────────────────────────
  async search(q: string) {
    set({ searchQuery: q });
    if (!q || q.length < 2) { set({ searchResults: null }); return; }
    const { activeChannel, activeConv } = get();
    const qs = new URLSearchParams({ q, limit: '30' });
    if (activeChannel) qs.set('channelId', activeChannel.id);
    if (activeConv)    qs.set('conversationId', activeConv.id);
    const results = await api.get(`/search?${qs}`);
    set({ searchResults: results.hits || [] });
  },

  clearSearch() { set({ searchResults: null, searchQuery: '' }); },

  // ── WebSocket event handler ───────────────────────────────────────────────
  _handleWsEvent(event: any) {
    // Note: this is called as a standalone fn, not as a method, so use get()
    const store = useChatStore.getState();
    switch (event.event) {
      case 'message:created': {
        const msg = hydrateAuthorFromSession(event.data);
        const key = msg.channel_id || msg.conversation_id;
        set(s => ({
          messages: {
            ...s.messages,
            [key]: upsertMessage(s.messages[key], msg),
          },
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
        }));
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
          api.put(`/messages/${msg.id}/read`).catch(() => {});
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
        const { userId, status } = event.data;
        store.setPresence(userId, status);
        break;
      }
      case 'read:updated': {
        const { conversationId, userId, lastReadMessageId, lastReadAt } = event.data || {};
        if (!conversationId || !userId) break;
        const me = useAuthStore.getState().user;
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
      case 'community:member_joined': {
        const { communityId } = event.data;
        if (store.activeCommunity?.id === communityId) {
          store.fetchMembers(communityId);
        }
        break;
      }
    }
  },
}));
