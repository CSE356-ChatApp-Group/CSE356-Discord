import { afterEach, describe, expect, it, vi } from 'vitest';
import { wsManager } from '../lib/ws';
import { resetChatStore, useChatStore } from './chatStore';

const { apiDelete, apiGet, apiPost, invalidateApiCache } = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  invalidateApiCache: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    get: apiGet,
    post: apiPost,
    postForm: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: apiDelete,
  },
  invalidateApiCache,
}));

import { useAuthStore } from './authStore';

afterEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: null });
  resetChatStore();
});

describe('list fetch cache bust', () => {
  it('invalidates /communities before fetchCommunities', async () => {
    apiGet.mockResolvedValue({ communities: [] });
    useAuthStore.setState({ user: { id: 'u1', username: 'a', displayName: 'A', email: 'a@test' } } as any);
    await useChatStore.getState().fetchCommunities();
    expect(invalidateApiCache).toHaveBeenCalledWith('/communities');
    expect(apiGet).toHaveBeenCalledWith('/communities');
  });

  it('invalidates per-community channels query before fetchChannels', async () => {
    apiGet.mockResolvedValue({ channels: [] });
    await useChatStore.getState().fetchChannels('comm-99');
    expect(invalidateApiCache).toHaveBeenCalledWith('/channels?communityId=comm-99');
    expect(apiGet).toHaveBeenCalledWith('/channels?communityId=comm-99');
  });
});

describe('community id invariants', () => {
  it('selectCommunity throws when id is missing', async () => {
    await expect(
      useChatStore.getState().selectCommunity({ name: 'No ID' } as any),
    ).rejects.toThrow('selectCommunity requires a valid community id');
  });

  it('fetchChannels throws before issuing request when id is missing', async () => {
    await expect(
      useChatStore.getState().fetchChannels(''),
    ).rejects.toThrow('fetchChannels requires a valid community id');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetchMembers throws before issuing request when id is missing', async () => {
    await expect(
      useChatStore.getState().fetchMembers('   '),
    ).rejects.toThrow('fetchMembers requires a valid community id');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('createCommunity normalizes nested communityId response shape', async () => {
    apiPost.mockResolvedValue({
      community: {
        communityId: 'comm-123',
        slug: 'alpha',
        name: 'Alpha',
      },
    });

    const created = await useChatStore.getState().createCommunity('alpha', 'Alpha', 'desc');
    expect(created.id).toBe('comm-123');
    expect(created.communityId).toBe('comm-123');
  });
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

  it('does not let stale presence hydration overwrite a newer realtime update', async () => {
    let resolvePresence: ((value: any) => void) | null = null;
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith('/presence?userIds=')) {
        return new Promise((resolve) => {
          resolvePresence = resolve;
        });
      }
      return Promise.resolve({});
    });

    const hydratePromise = useChatStore.getState().hydratePresenceForUsers(['user-2']);
    useChatStore.getState().setPresence('user-2', 'online');

    resolvePresence?.({
      presence: { 'user-2': 'offline' },
      awayMessages: {},
    });

    await hydratePromise;

    expect(useChatStore.getState().presence['user-2']).toBe('online');
  });

  it('inviteToChannel posts invited users and refreshes active community channels', async () => {
    apiPost.mockResolvedValue({ members: [{ id: 'user-2', username: 'alex' }] });
    apiGet.mockResolvedValue({ channels: [] });

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [{ id: 'ch-1', community_id: 'comm-1', name: 'secret' }],
    } as any);

    const members = await useChatStore.getState().inviteToChannel('ch-1', ['user-2']);

    expect(apiPost).toHaveBeenCalledWith('/channels/ch-1/members', { userIds: ['user-2'] });
    expect(invalidateApiCache).toHaveBeenCalledWith('/channels?communityId=comm-1');
    expect(apiGet).toHaveBeenCalledWith('/channels?communityId=comm-1');
    expect(members).toEqual([{ id: 'user-2', username: 'alex' }]);
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

  it('selectCommunity does not wait for members before selecting the first accessible channel', async () => {
    let resolveMembers: ((value: { members: { id: string }[] }) => void) | undefined;

    apiGet.mockImplementation((path: string) => {
      if (path === '/channels?communityId=comm-1') {
        return Promise.resolve({
          channels: [
            { id: 'ch-1', community_id: 'comm-1', name: 'general', can_access: true },
            { id: 'ch-2', community_id: 'comm-1', name: 'staff', can_access: false },
          ],
        });
      }

      if (path === '/communities/comm-1/members') {
        return new Promise((resolve) => {
          resolveMembers = resolve;
        });
      }

      if (path === '/messages?channelId=ch-1&limit=50') {
        return Promise.resolve({ messages: [] });
      }
      if (path.startsWith('/presence?userIds=')) {
        return Promise.resolve({ presence: { 'user-1': 'offline' }, awayMessages: {} });
      }

      throw new Error(`Unexpected GET ${path}`);
    });

    const selectPromise = useChatStore.getState().selectCommunity({ id: 'comm-1', name: 'One' } as any);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (useChatStore.getState().activeChannel?.id === 'ch-1') break;
      await Promise.resolve();
    }

    expect(useChatStore.getState().activeCommunity?.id).toBe('comm-1');
    expect(useChatStore.getState().activeChannel?.id).toBe('ch-1');

    resolveMembers?.({ members: [{ id: 'user-1' }] });
    await selectPromise;

    expect(useChatStore.getState().members).toEqual([{ id: 'user-1' }]);
  });

  it('selectCommunity prefers the fresh stored community row over a stale passed object', async () => {
    let resolveMembers: ((value: { members: { id: string }[] }) => void) | undefined;

    apiGet.mockImplementation((path: string) => {
      if (path === '/channels?communityId=comm-1') {
        return Promise.resolve({
          channels: [
            { id: 'ch-1', community_id: 'comm-1', name: 'general', can_access: true },
          ],
        });
      }

      if (path === '/communities/comm-1/members') {
        return new Promise((resolve) => {
          resolveMembers = resolve;
        });
      }

      if (path === '/messages?channelId=ch-1&limit=50') {
        return Promise.resolve({ messages: [] });
      }
      if (path.startsWith('/presence?userIds=')) {
        return Promise.resolve({ presence: { 'user-1': 'offline' }, awayMessages: {} });
      }

      throw new Error(`Unexpected GET ${path}`);
    });

    useChatStore.setState({
      communities: [{ id: 'comm-1', name: 'One', my_role: 'member', myRole: 'member' }],
    } as any);

    const selectPromise = useChatStore.getState().selectCommunity({ id: 'comm-1', name: 'One' } as any);

    resolveMembers?.({ members: [{ id: 'user-1' }] });
    await selectPromise;

    expect(useChatStore.getState().activeCommunity).toMatchObject({
      id: 'comm-1',
      my_role: 'member',
      myRole: 'member',
    });
  });

  it('selectCommunity keeps the current target visible until the replacement channel is ready', async () => {
    let resolveMembers: ((value: { members: { id: string }[] }) => void) | undefined;

    apiGet.mockImplementation((path: string) => {
      if (path === '/channels?communityId=comm-1') {
        return Promise.resolve({
          channels: [
            { id: 'ch-1', community_id: 'comm-1', name: 'general', can_access: true },
          ],
        });
      }

      if (path === '/communities/comm-1/members') {
        return new Promise((resolve) => {
          resolveMembers = resolve;
        });
      }

      if (path === '/messages?channelId=ch-1&limit=50') {
        return Promise.resolve({ messages: [] });
      }
      if (path.startsWith('/presence?userIds=')) {
        return Promise.resolve({ presence: { 'user-1': 'offline' }, awayMessages: {} });
      }

      throw new Error(`Unexpected GET ${path}`);
    });

    useChatStore.setState({
      activeConv: { id: 'conv-1', name: 'Existing DM' },
    } as any);

    const selectPromise = useChatStore.getState().selectCommunity({ id: 'comm-1', name: 'One' } as any);

    expect(useChatStore.getState().activeConv?.id).toBe('conv-1');
    expect(useChatStore.getState().activeChannel).toBeNull();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (useChatStore.getState().activeChannel?.id === 'ch-1') break;
      await Promise.resolve();
    }

    expect(useChatStore.getState().activeChannel?.id).toBe('ch-1');
    expect(useChatStore.getState().activeConv).toBeNull();

    resolveMembers?.({ members: [{ id: 'user-1' }] });
    await selectPromise;
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

  it('keeps a newly created channel visible when the immediate refresh is stale', async () => {
    // createChannel retries up to 4 times with real sleeps (250+500+750+1000ms = 2500ms)
    // when the server response doesn't yet include the new channel. Use fake timers so the
    // test completes instantly instead of burning ~2.5 s of real wall-clock time.
    vi.useFakeTimers();
    try {
      apiPost.mockResolvedValue({
        channel: { id: 'ch-2', community_id: 'comm-1', name: 'fresh' },
      });
      apiGet.mockResolvedValue({
        channels: [{ id: 'ch-1', community_id: 'comm-1', name: 'general' }],
      });

      useChatStore.setState({
        activeCommunity: { id: 'comm-1', name: 'One' },
        channels: [{ id: 'ch-1', community_id: 'comm-1', name: 'general' }],
      } as any);

      // Don't await immediately — advance fake timers past all 4 retry sleeps first.
      const createPromise = useChatStore.getState().createChannel('comm-1', 'fresh');
      await vi.advanceTimersByTimeAsync(3000);
      await createPromise;

      useChatStore.getState()._handleWsEvent({
        event: 'channel:created',
        data: { id: 'ch-2', community_id: 'comm-1', name: 'fresh' },
      });
      await Promise.resolve();

      expect(useChatStore.getState().channels.map((channel) => channel.id)).toContain('ch-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes channels when a private-channel membership update arrives for the active community', () => {
    const fetchChannels = vi.fn().mockResolvedValue([]);
    const subscribeSpy = vi.spyOn(wsManager, 'subscribe').mockReturnValue(() => false);
    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      fetchChannels,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'channel:membership_updated',
      data: { communityId: 'comm-1', channelId: 'ch-1' },
    });

    expect(subscribeSpy).toHaveBeenCalledWith('channel:ch-1', expect.any(Function));
    expect(fetchChannels).toHaveBeenCalledWith('comm-1');
    subscribeSpy.mockRestore();
  });

  it('subscribes to channel WS on membership update even when that community is not active', () => {
    const subscribeSpy = vi.spyOn(wsManager, 'subscribe').mockReturnValue(() => false);
    useChatStore.setState({
      activeCommunity: { id: 'comm-other', name: 'Other' },
      fetchChannels: vi.fn(),
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'channel:membership_updated',
      data: { communityId: 'comm-1', channelId: 'ch-99' },
    });

    expect(subscribeSpy).toHaveBeenCalledWith('channel:ch-99', expect.any(Function));
    expect(useChatStore.getState().fetchChannels).not.toHaveBeenCalled();
    subscribeSpy.mockRestore();
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

  it('applies channel:updated immediately and refetches the active community channel list', () => {
    const fetchChannels = vi.fn().mockResolvedValue([]);

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [
        { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: false },
      ],
      activeChannel: { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: false },
      fetchChannels,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'channel:updated',
      data: { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: true },
    });

    const state = useChatStore.getState();
    expect(state.channels.find((channel) => channel.id === 'ch-1')?.is_private).toBe(true);
    expect(state.activeChannel?.is_private).toBe(true);
    expect(invalidateApiCache).toHaveBeenCalledWith('/channels?communityId=comm-1');
    expect(fetchChannels).toHaveBeenCalledWith('comm-1');
  });

  it('clears the active channel immediately when channel:updated says access was lost', () => {
    const fetchChannels = vi.fn().mockResolvedValue([]);

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [
        { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: false, can_access: true },
      ],
      activeChannel: { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: false, can_access: true },
      fetchChannels,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'channel:updated',
      data: {
        id: 'ch-1',
        community_id: 'comm-1',
        name: 'general',
        is_private: true,
        can_access: false,
      },
    });

    const state = useChatStore.getState();
    expect(state.channels.find((channel) => channel.id === 'ch-1')?.can_access).toBe(false);
    expect(state.activeChannel).toBeNull();
    expect(fetchChannels).toHaveBeenCalledWith('comm-1');
  });

  it('drops stale cached history when access flips and refetches on reopen', async () => {
    const fetchChannels = vi.fn().mockResolvedValue([]);
    apiGet.mockImplementation((path: string) => {
      if (path === '/messages?channelId=ch-1&limit=50') {
        return Promise.resolve({ messages: [] });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [
        { id: 'ch-1', community_id: 'comm-1', name: 'general', is_private: true, can_access: false },
      ],
      activeChannel: null,
      messages: {
        'ch-1': [{ id: 'm-stale', channel_id: 'ch-1', content: 'stale' }],
      },
      messagePagination: {
        'ch-1': { hasOlder: false, hasNewer: false },
      },
      fetchChannels,
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'channel:updated',
      data: {
        id: 'ch-1',
        community_id: 'comm-1',
        name: 'general',
        is_private: false,
        can_access: true,
      },
    });

    expect(useChatStore.getState().messages['ch-1']).toBeUndefined();
    expect(useChatStore.getState().messagePagination['ch-1']).toBeUndefined();

    await useChatStore.getState().selectChannel({
      id: 'ch-1',
      community_id: 'comm-1',
      name: 'general',
      is_private: false,
      can_access: true,
    } as any);

    expect(apiGet).toHaveBeenCalledWith('/messages?channelId=ch-1&limit=50');
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

  it('still merges message:created when hasNewer is true so the newest row appears in state', () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        username: 'sam',
        displayName: 'Sam',
        email: 'sam@example.com',
      },
    } as any);

    useChatStore.setState({
      activeChannel: { id: 'channel-1', name: 'general' },
      channels: [
        {
          id: 'channel-1',
          name: 'general',
          unread_message_count: 0,
          my_last_read_message_id: 'msg-old',
        },
      ],
      messages: {
        'channel-1': [
          {
            id: 'msg-old',
            channel_id: 'channel-1',
            author_id: 'user-2',
            content: 'older window',
            created_at: '2026-01-01T12:00:00.000Z',
          },
        ],
      },
      messagePagination: {
        'channel-1': { hasOlder: true, hasNewer: true },
      },
    } as any);

    useChatStore.getState()._handleWsEvent({
      event: 'message:created',
      data: {
        id: 'msg-live',
        channel_id: 'channel-1',
        author_id: 'user-2',
        content: 'arrived while paging newer',
        created_at: '2026-01-01T13:00:00.000Z',
      },
    });

    const list = useChatStore.getState().messages['channel-1'];
    expect(list.map((m: any) => m.id)).toEqual(['msg-old', 'msg-live']);
    const ch = useChatStore.getState().channels.find((c: any) => c.id === 'channel-1');
    expect(ch?.unread_message_count).toBe(1);
    expect(ch?.my_last_read_message_id).toBe('msg-old');
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

  it('adds conversation:invited directly to the DM list', () => {
    useChatStore.setState({ conversations: [] } as any);

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
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0].id).toBe('conv-1');
  });

  it('keeps participant_added conversation in active DM list', () => {
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
  });

  it('adds participant_added to DM list when current user was newly added', () => {
    useAuthStore.setState({
      user: {
        id: 'user-3',
        username: 'lee',
        displayName: 'Lee',
        email: 'lee@example.com',
      },
    });

    useChatStore.setState({ conversations: [] } as any);

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
    expect(state.conversations.some((conv) => conv.id === 'conv-3')).toBe(true);
  });

  it('keeps group DM visible when another participant leaves and only me remains', () => {
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
          is_group: true,
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
    expect(state.conversations.some((c) => c.id === 'conv-1on1')).toBe(true);
    const conv = state.conversations.find((c) => c.id === 'conv-1on1');
    expect(conv?.participants?.some((p) => p.id === 'user-other')).toBe(false);
    expect(conv?.participants?.some((p) => p.id === 'user-me')).toBe(true);
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

// ── Issue #39: data leak on logout → register ─────────────────────────────────

describe('resetChatStore / expireSession data isolation', () => {
  it('reset() clears all chat state', () => {
    useChatStore.setState({
      communities:     [{ id: 'comm-1' }],
      activeCommunity: { id: 'comm-1' },
      channels:        [{ id: 'ch-1' }],
      activeChannel:   { id: 'ch-1' },
      conversations:   [{ id: 'conv-1' }],
      activeConv:      { id: 'conv-1' },
      messages:        { 'ch-1': [{ id: 'm-1' }] },
      members:         [{ id: 'user-a' }],
      presence:        { 'user-a': 'online' } as any,
      awayMessages:    { 'user-a': 'out' },
      searchResults:   [{ id: 'r-1' }],
      searchQuery:     'hello',
      searchFilters:   { author: 'user-a', after: '2026-04-06T08:00', before: '2026-04-06T09:00' },
    } as any);

    useChatStore.getState().reset();

    const s = useChatStore.getState();
    expect(s.communities).toEqual([]);
    expect(s.activeCommunity).toBeNull();
    expect(s.channels).toEqual([]);
    expect(s.activeChannel).toBeNull();
    expect(s.conversations).toEqual([]);
    expect(s.activeConv).toBeNull();
    expect(s.messages).toEqual({});
    expect(s.members).toEqual([]);
    expect(s.presence).toEqual({});
    expect(s.awayMessages).toEqual({});
    expect(s.searchResults).toBeNull();
    expect(s.searchQuery).toBe('');
    expect(s.searchFilters).toEqual({ author: '', after: '', before: '' });
  });

  it('resetChatStore() clears state so a new user does not see previous user data', () => {
    // Seed "user A" data
    useChatStore.setState({
      communities:  [{ id: 'comm-a', name: 'User A community' }],
      activeConv:   { id: 'dm-a' },
      messages:     { 'dm-a': [{ id: 'm-1', content: 'secret message' }] },
      messagePagination: { 'dm-a': { hasOlder: false, hasNewer: true } },
      members:      [{ id: 'user-a' }],
    } as any);

    // Simulate logout / session expiry
    resetChatStore();

    const s = useChatStore.getState();
    expect(s.communities).toEqual([]);
    expect(s.activeConv).toBeNull();
    expect(s.messages).toEqual({});
    expect(s.messagePagination).toEqual({});
    expect(s.members).toEqual([]);
  });
});

describe('search filters', () => {
  it('includes author and time range filters in conversation-scoped searches', async () => {
    apiGet.mockResolvedValue({ hits: [] });

    useChatStore.setState({
      activeConv: {
        id: 'conv-1',
        participants: [{ id: 'user-2', username: 'user-2' }],
      },
      members: [{ id: 'user-2', username: 'user-2' }],
      searchFilters: {
        author: 'user-2',
        after: '2026-04-06T09:15',
        before: '2026-04-06T10:45',
      },
    } as any);

    await useChatStore.getState().search('hello');

    const requestedPath = apiGet.mock.calls[0]?.[0] as string;
    expect(requestedPath).toContain('/search?');
    expect(requestedPath).toContain('conversationId=conv-1');
    expect(requestedPath).toContain('authorId=user-2');
    expect(requestedPath).toContain(`after=${encodeURIComponent(new Date('2026-04-06T09:15').toISOString())}`);
    expect(requestedPath).toContain(`before=${encodeURIComponent(new Date('2026-04-06T10:45').toISOString())}`);
  });

  it('stores incoming filter overrides when search is called directly', async () => {
    apiGet.mockResolvedValue({ hits: [] });

    useChatStore.setState({
      activeConv: { id: 'conv-1' },
      members: [{ id: 'user-7', username: 'user-7' }],
      searchFilters: { author: '', after: '', before: '' },
    } as any);

    await useChatStore.getState().search('status', {
      author: 'user-7',
      after: '2026-04-06T12:00',
    });

    expect(useChatStore.getState().searchFilters).toEqual({
      author: 'user-7',
      after: '2026-04-06T12:00',
      before: '',
    });
  });

  it('uses channel scope when a channel is active', async () => {
    apiGet.mockResolvedValue({ hits: [] });

    useChatStore.setState({
      activeCommunity: { id: 'comm-1', name: 'One' },
      activeChannel: { id: 'ch-1', name: 'general', community_id: 'comm-1' },
      activeConv: null,
      searchFilters: { author: '', after: '', before: '' },
    } as any);

    await useChatStore.getState().search('hi');

    const requestedPath = apiGet.mock.calls[0]?.[0] as string;
    expect(requestedPath).toContain('/search?');
    expect(requestedPath).toContain('channelId=ch-1');
    expect(requestedPath).not.toContain('communityId=comm-1');
  });

  it('includes a single-character text query instead of dropping it in favor of filters', async () => {
    apiGet.mockResolvedValue({ hits: [] });

    useChatStore.setState({
      activeConv: {
        id: 'conv-1',
        participants: [{ id: 'user-2', username: 'user-2' }],
      },
      members: [{ id: 'user-2', username: 'user-2' }],
      searchFilters: {
        author: 'user-2',
        after: '',
        before: '',
      },
    } as any);

    await useChatStore.getState().search('f');

    const requestedPath = apiGet.mock.calls[0]?.[0] as string;
    expect(requestedPath).toContain('/search?');
    expect(requestedPath).toContain('q=f');
    expect(requestedPath).toContain('authorId=user-2');
  });

  it('does not resolve the author filter from a username substring', async () => {
    apiGet.mockResolvedValue({ hits: [] });

    useChatStore.setState({
      activeConv: {
        id: 'conv-1',
        participants: [
          { id: 'user-1', username: 'abcdef' },
          { id: 'user-2', username: 'abcd' },
        ],
      },
      members: [],
      searchFilters: {
        author: 'abc',
        after: '',
        before: '',
      },
      searchResults: [{ id: 'old-result' }],
    } as any);

    await useChatStore.getState().search('hello');

    expect(apiGet).not.toHaveBeenCalled();
    expect(useChatStore.getState().searchResults).toEqual([]);
  });

  it('ignores stale search responses and keeps the latest result set', async () => {
    let resolveFirst: ((value: any) => void) | null = null;
    let resolveSecond: ((value: any) => void) | null = null;
    apiGet
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    useChatStore.setState({
      activeConv: { id: 'conv-1', participants: [] },
      searchFilters: { author: '', after: '', before: '' },
    } as any);

    const firstSearch = useChatStore.getState().search('old query');
    const secondSearch = useChatStore.getState().search('new query');

    resolveSecond?.({ hits: [{ id: 'new-hit' }] });
    await secondSearch;
    resolveFirst?.({ hits: [{ id: 'old-hit' }] });
    await firstSearch;

    expect(useChatStore.getState().searchResults).toEqual([{ id: 'new-hit' }]);
    expect(useChatStore.getState().searchQuery).toBe('new query');
  });

  it('surfaces a search error instead of silently doing nothing', async () => {
    apiGet.mockRejectedValue(Object.assign(new Error('Search temporarily unavailable'), { status: 503 }));

    useChatStore.setState({
      activeConv: { id: 'conv-1', participants: [] },
      searchFilters: { author: '', after: '', before: '' },
    } as any);

    await useChatStore.getState().search('hello');

    expect(useChatStore.getState().searchResults).toEqual([]);
    expect(useChatStore.getState().searchError).toBe('Search temporarily unavailable');
  });

  it('loads only the clicked result context and stores the jump target', async () => {
    apiGet.mockResolvedValue({
      targetMessageId: 'msg-2',
      channelId: 'ch-2',
      messages: [
        { id: 'msg-1', content: 'before' },
        { id: 'msg-2', content: 'target' },
        { id: 'msg-3', content: 'after' },
      ],
    });

    useChatStore.setState({
      communities: [{ id: 'comm-1', name: 'One' }],
      activeCommunity: { id: 'comm-1', name: 'One' },
      channels: [
        { id: 'ch-1', community_id: 'comm-1', name: 'general' },
        { id: 'ch-2', community_id: 'comm-1', name: 'random' },
      ],
      activeChannel: { id: 'ch-1', community_id: 'comm-1', name: 'general' },
      messages: {
        'ch-1': [{ id: 'existing-message', content: 'hello' }],
      },
    } as any);

    await useChatStore.getState().jumpToSearchResult({
      id: 'msg-2',
      channelId: 'ch-2',
      channelName: 'random',
      communityId: 'comm-1',
    });

    const state = useChatStore.getState();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/messages/context/msg-2?limit=25');
    expect(state.activeChannel?.id).toBe('ch-2');
    expect(state.activeConv).toBeNull();
    expect(state.messages['ch-2'].map((message: any) => message.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(state.messagePagination['ch-2']).toEqual({ hasOlder: false, hasNewer: false });
    expect(state.jumpTargetMessageId).toBe('msg-2');
  });

  it('pages newer history from an anchored result without replacing the existing window', async () => {
    apiGet.mockResolvedValueOnce({
      targetMessageId: 'msg-2',
      channelId: 'ch-2',
      hasOlder: true,
      hasNewer: true,
      messages: [
        { id: 'msg-1', content: 'before' },
        { id: 'msg-2', content: 'target' },
        { id: 'msg-3', content: 'after' },
      ],
    });
    apiGet.mockResolvedValueOnce({
      messages: [
        { id: 'msg-4', content: 'next' },
        { id: 'msg-5', content: 'newest' },
      ],
    });

    useChatStore.setState({
      channels: [{ id: 'ch-2', community_id: 'comm-1', name: 'random' }],
    } as any);

    await useChatStore.getState().jumpToSearchResult({
      id: 'msg-2',
      channelId: 'ch-2',
      channelName: 'random',
    });

    await useChatStore.getState().fetchMessages({
      channelId: 'ch-2',
      after: 'msg-3',
    });

    const state = useChatStore.getState();
    expect(apiGet).toHaveBeenNthCalledWith(2, '/messages?channelId=ch-2&after=msg-3&limit=50');
    expect(state.messages['ch-2'].map((message: any) => message.id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
    expect(state.messagePagination['ch-2']).toEqual({ hasOlder: true, hasNewer: false });
  });

  it('merge initial fetch with in-memory messages from WS so opening a DM does not drop newer rows', async () => {
    apiGet.mockResolvedValue({
      messages: [
        { id: 'm-old', content: 'from api', created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });

    useAuthStore.setState({
      user: { id: 'user-a', username: 'a', displayName: 'A', email: 'a@test' },
    } as any);

    useChatStore.setState({
      conversations: [{ id: 'conv-1', name: 'B', participants: [{ id: 'user-b' }] }],
      messages: {
        'conv-1': [
          {
            id: 'm-ws',
            content: 'from websocket first',
            created_at: '2026-01-01T00:00:02.000Z',
            conversation_id: 'conv-1',
            author_id: 'user-b',
          },
        ],
      },
      messagePagination: {},
    } as any);

    await useChatStore.getState().fetchMessages({ conversationId: 'conv-1' });

    expect(invalidateApiCache).toHaveBeenCalledWith('/messages?');

    const list = useChatStore.getState().messages['conv-1'];
    expect(list.map((m: any) => m.id)).toEqual(['m-old', 'm-ws']);
    expect(list.find((m: any) => m.id === 'm-ws')?.content).toBe('from websocket first');
  });
});
