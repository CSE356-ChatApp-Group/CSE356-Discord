import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';

afterEach(() => {
  useAuthStore.setState({ user: null });
  useChatStore.setState({ messages: {} });
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
