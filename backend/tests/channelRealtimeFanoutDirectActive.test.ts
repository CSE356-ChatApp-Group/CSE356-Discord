/**
 * Direct-active channel fanout must remain an optimization, not the sole
 * delivery path for already-subscribed channel sockets.
 */

describe('channelRealtimeFanout direct-active path', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      CHANNEL_MESSAGE_USER_FANOUT_MODE: 'recent_connect',
      CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH: 'true',
      CHANNEL_MESSAGE_DIRECT_ACTIVE_USER_MAX: '512',
      CHANNEL_RECENT_ZSET_ENABLED: 'true',
    };
  });

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function loadWithMocks() {
    const query = jest.fn();
    const publish = jest.fn((_channel: string, _payload: unknown) => Promise.resolve());
    const enqueuePendingMessageForUsers = jest.fn(() => Promise.resolve());
    const redis = {
      mget: jest.fn(() => Promise.resolve([null, '0'])),
      get: jest.fn(() => Promise.resolve('0')),
      set: jest.fn(() => Promise.resolve('OK')),
      zrangebyscore: jest.fn(() => Promise.resolve([])),
      call: jest.fn(() => Promise.resolve([1, 0])),
      pipeline: jest.fn(() => ({
        del: jest.fn().mockReturnThis(),
        incr: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve([])),
      })),
    };

    jest.doMock('../src/db/pool', () => ({ query }));
    jest.doMock('../src/db/redis', () => redis);
    jest.doMock('../src/db/redisBatch', () => ({
      redisBatchSmismember: jest.fn((client, key, members) => client.call('SMISMEMBER', key, ...members)),
    }));
    jest.doMock('../src/websocket/fanout', () => ({ publish }));
    jest.doMock('../src/websocket/userFeed', () => ({
      publishUserFeedTargets: jest.fn(async (targets, envelope) => {
        for (const target of targets) {
          const userId = String(target).startsWith('user:') ? String(target).slice(5) : String(target);
          await publish(`userfeed:${userId}`, envelope);
        }
      }),
    }));
    jest.doMock('../src/websocket/communityFeed', () => ({
      publishCommunityFeedMessage: jest.fn(() => Promise.resolve()),
    }));
    jest.doMock('../src/messages/pending/realtimePending', () => ({
      enqueuePendingMessageForUsers,
    }));
    jest.doMock('../src/messages/sideEffects', () => ({
      enqueueFanoutJob: jest.fn((_name, fn) => fn()),
    }));
    jest.doMock('../src/utils/metrics', () => new Proxy({}, {
      get: () => ({ inc: jest.fn(), observe: jest.fn(), set: jest.fn() }),
    }));

    const fanoutModule = require('../src/messages/fanout/channelRealtimeFanout');
    return {
      publishChannelMessageCreated: fanoutModule.publishChannelMessageCreated as (
        channelId: string,
        envelope: Record<string, unknown>,
        opts?: { communityId?: string | null; isPrivate?: boolean | null },
      ) => Promise<void>,
      query,
      publish,
      redis,
      enqueuePendingMessageForUsers,
    };
  }

  it('keeps channel:<id> publish when direct-active presence misses a visible member', async () => {
    const {
      publishChannelMessageCreated,
      query,
      publish,
      redis,
      enqueuePendingMessageForUsers,
    } = loadWithMocks();
    query.mockResolvedValueOnce({ rows: [{ user_id: 'active-a' }, { user_id: 'stale-b' }] });

    await publishChannelMessageCreated(
      'chan-direct-active',
      { event: 'message:created', data: { id: 'm-direct-active' } },
      { communityId: 'community-1', isPrivate: true },
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(redis.call).toHaveBeenCalledWith(
      'SMISMEMBER',
      'presence:connected_users',
      'active-a',
      'stale-b',
    );
    expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
      ['user:active-a'],
      expect.objectContaining({ event: 'message:created' }),
      { recentTargets: ['user:active-a'] },
    );
    expect(publish.mock.calls.map((call) => call[0]).sort()).toEqual([
      'channel:chan-direct-active',
      'userfeed:active-a',
    ]);
  });
});
