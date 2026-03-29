import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiDelete } = vi.hoisted(() => ({
  apiDelete: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: apiDelete,
  },
}));

import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';

afterEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null });
  useChatStore.setState({
    communities: [],
    activeCommunity: null,
    channels: [],
    activeChannel: null,
    conversations: [],
    activeConv: null,
    members: [],
    pendingDmInvites: [],
    messages: {},
  } as any);
});

describe('chatStore quick actions', () => {
  it('deleteCommunity removes the active community, related channels, and cached messages', async () => {
    apiDelete.mockResolvedValue({ success: true });

    useChatStore.setState({
      communities: [
        { id: 'comm-1', name: 'One' },
        { id: 'comm-2', name: 'Two' },
      ],
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [
        { id: 'ch-1', community_id: 'comm-1', name: 'general' },
        { id: 'ch-2', community_id: 'comm-1', name: 'random' },
      ],
      activeChannel: { id: 'ch-1', community_id: 'comm-1', name: 'general' },
      members: [{ id: 'user-1' }],
      messages: {
        'ch-1': [{ id: 'm-1', content: 'hello' }],
        'ch-2': [{ id: 'm-2', content: 'hi' }],
        'other-thread': [{ id: 'm-3', content: 'keep' }],
      },
    } as any);

    await useChatStore.getState().deleteCommunity('comm-1');

    const state = useChatStore.getState();
    expect(apiDelete).toHaveBeenCalledWith('/communities/comm-1');
    expect(state.communities.map((community) => community.id)).toEqual(['comm-2']);
    expect(state.activeCommunity).toBeNull();
    expect(state.activeChannel).toBeNull();
    expect(state.channels).toEqual([]);
    expect(state.members).toEqual([]);
    expect(state.messages['ch-1']).toBeUndefined();
    expect(state.messages['ch-2']).toBeUndefined();
    expect(state.messages['other-thread']).toBeDefined();
  });

  it('leaveCommunity removes the active community and clears related selection state', async () => {
    apiDelete.mockResolvedValue({ success: true });

    useChatStore.setState({
      communities: [
        { id: 'comm-1', name: 'One' },
        { id: 'comm-2', name: 'Two' },
      ],
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [{ id: 'ch-1', community_id: 'comm-1' }],
      activeChannel: { id: 'ch-1', community_id: 'comm-1' },
      members: [{ id: 'user-1' }],
    } as any);

    await useChatStore.getState().leaveCommunity('comm-1');

    const state = useChatStore.getState();
    expect(apiDelete).toHaveBeenCalledWith('/communities/comm-1/leave');
    expect(state.communities.map((community) => community.id)).toEqual(['comm-2']);
    expect(state.activeCommunity).toBeNull();
    expect(state.activeChannel).toBeNull();
    expect(state.channels).toEqual([]);
    expect(state.members).toEqual([]);
  });

  it('leaveCommunity keeps current selection when leaving a non-active community', async () => {
    apiDelete.mockResolvedValue({ success: true });

    useChatStore.setState({
      communities: [
        { id: 'comm-1', name: 'One' },
        { id: 'comm-2', name: 'Two' },
      ],
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [{ id: 'ch-1', community_id: 'comm-1' }],
      activeChannel: { id: 'ch-1', community_id: 'comm-1' },
      members: [{ id: 'user-1' }],
    } as any);

    await useChatStore.getState().leaveCommunity('comm-2');

    const state = useChatStore.getState();
    expect(apiDelete).toHaveBeenCalledWith('/communities/comm-2/leave');
    expect(state.communities.map((community) => community.id)).toEqual(['comm-1']);
    expect(state.activeCommunity?.id).toBe('comm-1');
    expect(state.activeChannel?.id).toBe('ch-1');
    expect(state.channels.map((channel) => channel.id)).toEqual(['ch-1']);
    expect(state.members.map((member) => member.id)).toEqual(['user-1']);
  });

  it('removes a deleted community when a websocket delete event arrives', () => {
    useChatStore.setState({
      communities: [
        { id: 'comm-1', name: 'One' },
        { id: 'comm-2', name: 'Two' },
      ],
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [{ id: 'ch-1', community_id: 'comm-1', name: 'general' }],
      activeChannel: { id: 'ch-1', community_id: 'comm-1', name: 'general' },
      messages: { 'ch-1': [{ id: 'm-1', content: 'hello' }] },
      members: [{ id: 'user-1' }],
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'community:deleted',
      data: { communityId: 'comm-1' },
    });

    const state = useChatStore.getState();
    expect(state.communities.map((community) => community.id)).toEqual(['comm-2']);
    expect(state.activeCommunity).toBeNull();
    expect(state.activeChannel).toBeNull();
    expect(state.channels).toEqual([]);
    expect(state.messages['ch-1']).toBeUndefined();
  });

  it('deleteChannel removes channel, active selection, and cached message thread', async () => {
    apiDelete.mockResolvedValue({ success: true });

    useChatStore.setState({
      channels: [
        { id: 'ch-1', name: 'general' },
        { id: 'ch-2', name: 'random' },
      ],
      activeChannel: { id: 'ch-1', name: 'general' },
      messages: {
        'ch-1': [{ id: 'm-1', content: 'hello' }],
        'ch-2': [{ id: 'm-2', content: 'hi' }],
      },
    } as any);

    await useChatStore.getState().deleteChannel('ch-1');

    const state = useChatStore.getState();
    expect(apiDelete).toHaveBeenCalledWith('/channels/ch-1');
    expect(state.channels.map((channel) => channel.id)).toEqual(['ch-2']);
    expect(state.activeChannel).toBeNull();
    expect(state.messages['ch-1']).toBeUndefined();
    expect(state.messages['ch-2']).toBeDefined();
  });
});

describe('chatStore websocket author hydration', () => {
  it('hydrates author for current-user message:created events missing author', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    });

    useChatStore.getState()._handleWsEvent({
      event: 'message:created',
      data: {
        id: 'msg-1',
        channel_id: 'channel-1',
        author_id: 'user-1',
        content: 'hello',
        created_at: new Date().toISOString(),
      },
    });

    const stored = useChatStore.getState().messages['channel-1'][0];
    expect(stored.author).toBeDefined();
    expect(stored.author.id).toBe('user-1');
    expect(stored.author.displayName).toBe('Sam');
    expect(stored.author.display_name).toBe('Sam');
  });

  it('does not synthesize author for other users', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    });

    useChatStore.getState()._handleWsEvent({
      event: 'message:created',
      data: {
        id: 'msg-2',
        channel_id: 'channel-1',
        author_id: 'user-2',
        content: 'hello from someone else',
        created_at: new Date().toISOString(),
      },
    });

    const stored = useChatStore.getState().messages['channel-1'][0];
    expect(stored.author).toBeUndefined();
  });

  it('stores conversation system messages without author in the correct thread', () => {
    const now = new Date().toISOString();

    useChatStore.getState()._handleWsEvent({
      event: 'message:created',
      data: {
        id: 'sys-1',
        conversation_id: 'conv-1',
        author_id: null,
        content: 'Alex left the group.',
        type: 'system',
        created_at: now,
      },
    });

    const stored = useChatStore.getState().messages['conv-1'][0];
    expect(stored).toBeDefined();
    expect(stored.id).toBe('sys-1');
    expect(stored.type).toBe('system');
    expect(stored.author_id).toBeNull();
    expect(stored.author).toBeUndefined();
  });

  it('hydrates author for current-user message:updated events missing author', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    });

    useChatStore.setState({
      messages: {
        'channel-1': [
          {
            id: 'msg-3',
            channel_id: 'channel-1',
            author_id: 'user-1',
            content: 'before',
            created_at: new Date().toISOString(),
          },
        ],
      },
    });

    useChatStore.getState()._handleWsEvent({
      event: 'message:updated',
      data: {
        id: 'msg-3',
        channel_id: 'channel-1',
        author_id: 'user-1',
        content: 'after',
        created_at: new Date().toISOString(),
      },
    });

    const stored = useChatStore.getState().messages['channel-1'][0];
    expect(stored.content).toBe('after');
    expect(stored.author).toBeDefined();
    expect(stored.author.id).toBe('user-1');
  });

  it('queues conversation:invited as a pending DM invite', () => {
    useChatStore.setState({ conversations: [], pendingDmInvites: [] } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'conversation:invited',
      data: {
        conversationId: 'conv-1',
        conversation: {
          id: 'conv-1',
          participants: [{ id: 'user-1', username: 'sam' }, { id: 'user-2', username: 'alex' }],
        },
      },
    });

    const state = useChatStore.getState();
    expect(state.pendingDmInvites).toHaveLength(1);
    expect(state.pendingDmInvites[0].id).toBe('conv-1');
    expect(state.conversations).toHaveLength(0);
  });

  it('promotes participant_added conversation to active DM list and clears pending invite', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    });

    useChatStore.setState({
      conversations: [],
      pendingDmInvites: [{ id: 'conv-2', participants: [{ id: 'user-1' }, { id: 'user-3' }] }],
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'conversation:participant_added',
      data: {
        conversationId: 'conv-2',
        participantIds: ['user-4'],
        conversation: {
          id: 'conv-2',
          participants: [{ id: 'user-1', username: 'sam' }, { id: 'user-3', username: 'lee' }],
        },
      },
    });

    const state = useChatStore.getState();
    expect(state.conversations.some((conv) => conv.id === 'conv-2')).toBe(true);
    expect(state.pendingDmInvites.some((invite) => invite.id === 'conv-2')).toBe(false);
  });

  it('keeps participant_added as pending invite when current user was newly added', () => {
    useAuthStore.setState({
      user: {
        id: 'user-3',
        username: 'lee',
        displayName: 'Lee',
        email: 'lee@example.com',
      },
    });

    useChatStore.setState({ conversations: [], pendingDmInvites: [] } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'conversation:participant_added',
      data: {
        conversationId: 'conv-3',
        participantIds: ['user-3'],
        conversation: {
          id: 'conv-3',
          participants: [{ id: 'user-1', username: 'sam' }, { id: 'user-3', username: 'lee' }],
        },
      },
    });

    const state = useChatStore.getState();
    expect(state.pendingDmInvites.some((invite) => invite.id === 'conv-3')).toBe(true);
    expect(state.conversations.some((conv) => conv.id === 'conv-3')).toBe(false);
  });

  it('removes 1:1 DM from sidebar when the other participant leaves', () => {
    useAuthStore.setState({
      user: {
        id: 'user-me',
        username: 'me',
        displayName: 'Me',
        email: 'me@example.com',
      },
    });

    useChatStore.setState({
      conversations: [
        {
          id: 'conv-1on1',
          participants: [
            { id: 'user-me', username: 'me' },
            { id: 'user-other', username: 'other' },
          ],
        },
      ],
      activeConv: null,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'conversation:participant_left',
      data: {
        conversationId: 'conv-1on1',
        leftUserId: 'user-other',
      },
    });

    const state = useChatStore.getState();
    expect(state.conversations.some((c) => c.id === 'conv-1on1')).toBe(false);
  });

  it('keeps group DM in sidebar when one of three participants leaves', () => {
    useAuthStore.setState({
      user: {
        id: 'user-me',
        username: 'me',
        displayName: 'Me',
        email: 'me@example.com',
      },
    });

    useChatStore.setState({
      conversations: [
        {
          id: 'conv-group',
          participants: [
            { id: 'user-me', username: 'me' },
            { id: 'user-b', username: 'b' },
            { id: 'user-c', username: 'c' },
          ],
        },
      ],
      activeConv: null,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'conversation:participant_left',
      data: {
        conversationId: 'conv-group',
        leftUserId: 'user-c',
      },
    });

    const state = useChatStore.getState();
    // Conversation survives — user-b still remains alongside me
    expect(state.conversations.some((c) => c.id === 'conv-group')).toBe(true);
    const conv = state.conversations.find((c) => c.id === 'conv-group');
    expect(conv?.participants?.some((p) => p.id === 'user-c')).toBe(false);
    expect(conv?.participants?.some((p) => p.id === 'user-b')).toBe(true);
  });
});
