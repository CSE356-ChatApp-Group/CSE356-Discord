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
});
