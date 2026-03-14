import { create } from 'zustand';
import { api } from '../lib/api';
import { wsManager } from '../lib/ws';

function dedupeMessages(messages) {
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

export const useChatStore = create((set, get) => ({
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

  async createCommunity(slug, name, description) {
    const { community } = await api.post('/communities', { slug, name, description });
    set(s => ({ communities: [...s.communities, community] }));
    return community;
  },

  async selectCommunity(community) {
    set({ activeCommunity: community, activeChannel: null, activeConv: null });
    await get().fetchChannels(community.id);
    await get().fetchMembers(community.id);
    // Subscribe to community-level events
    wsManager.subscribe(`community:${community.id}`, get()._handleWsEvent);
  },

  // ── Channels ──────────────────────────────────────────────────────────────
  async fetchChannels(communityId) {
    const { channels } = await api.get(`/channels?communityId=${communityId}`);
    set({ channels });
    return channels;
  },

  async createChannel(communityId, name, isPrivate = false, description = '') {
    const { channel } = await api.post('/channels', { communityId, name, isPrivate, description });
    set(s => ({ channels: [...s.channels, channel] }));
    return channel;
  },

  async selectChannel(channel) {
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
  },

  async openDm(userId) {
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
    return conversation;
  },

  async selectConversation(conv) {
    set({ activeConv: conv, activeChannel: null });
    await get().fetchMessages({ conversationId: conv.id });
    wsManager.subscribe(`conversation:${conv.id}`, get()._handleWsEvent);
  },

  // ── Messages ──────────────────────────────────────────────────────────────
  async fetchMessages({ channelId, conversationId, before } = {}) {
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

  async sendMessage(content) {
    const { activeChannel, activeConv } = get();
    const body = { content };
    if (activeChannel)  body.channelId      = activeChannel.id;
    if (activeConv)     body.conversationId = activeConv.id;
    await api.post('/messages', body);
    // Optimistic update handled by WS event; if WS not connected, refetch
  },

  async editMessage(id, content) {
    await api.patch(`/messages/${id}`, { content });
  },

  async deleteMessage(id) {
    await api.delete(`/messages/${id}`);
  },

  // ── Members ───────────────────────────────────────────────────────────────
  async fetchMembers(communityId) {
    const { members } = await api.get(`/communities/${communityId}/members`);
    // Seed presence map from member list
    const presence = {};
    members.forEach(m => { presence[m.id] = m.status || 'offline'; });
    set({ members, presence: { ...get().presence, ...presence } });
  },

  // ── Presence ──────────────────────────────────────────────────────────────
  setPresence(userId, status) {
    set(s => ({ presence: { ...s.presence, [userId]: status } }));
  },

  // ── Search ────────────────────────────────────────────────────────────────
  async search(q) {
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
  _handleWsEvent(event) {
    // Note: this is called as a standalone fn, not as a method, so use get()
    const store = useChatStore.getState();
    switch (event.event) {
      case 'message:created': {
        const msg = event.data;
        const key = msg.channel_id || msg.conversation_id;
        set(s => ({
          messages: {
            ...s.messages,
            [key]: upsertMessage(s.messages[key], msg),
          },
        }));
        break;
      }
      case 'message:updated': {
        const msg = event.data;
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
