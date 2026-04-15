/**
 * Channel message:created fanout targets every visible member's user topic.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/websocket/fanout', () => ({
  publish: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/messages/sideEffects', () => ({
  enqueueFanoutJob: jest.fn((_name: string, fn: () => Promise<void>) => fn()),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve('OK')),
  del: jest.fn(() => Promise.resolve(1)),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fanout = require('../src/websocket/fanout') as { publish: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
} = require('../src/messages/channelRealtimeFanout') as {
  publishChannelMessageCreated: (channelId: string, envelope: Record<string, unknown>) => Promise<void>;
  getChannelUserFanoutTargetKeys: (channelId: string) => Promise<string[]>;
  invalidateChannelUserFanoutTargetsCache: (channelId: string) => Promise<void>;
  invalidateCommunityChannelUserFanoutTargetsCache: (communityId: string) => Promise<void>;
};

describe('channelRealtimeFanout', () => {
  afterEach(() => {
    query.mockReset();
    fanout.publish.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('getChannelUserFanoutTargetKeys returns distinct user: keys from query rows', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u1' }],
    });
    const keys = await getChannelUserFanoutTargetKeys('chan-1');
    expect(keys).toEqual(['user:u1', 'user:u2']);
  });

  it('getChannelUserFanoutTargetKeys reuses cached user fanout targets', async () => {
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(['user:cached-a', 'user:cached-b']));
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'cached-a' }, { user_id: 'cached-b' }],
    });

    const first = await getChannelUserFanoutTargetKeys('chan-2');
    const second = await getChannelUserFanoutTargetKeys('chan-2');

    expect(first).toEqual(['user:cached-a', 'user:cached-b']);
    expect(second).toEqual(['user:cached-a', 'user:cached-b']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'channel:chan-2:user_fanout_targets',
      JSON.stringify(['user:cached-a', 'user:cached-b']),
      'EX',
      180,
    );
  });

  it('invalidateChannelUserFanoutTargetsCache deletes the cached audience for one channel', async () => {
    await invalidateChannelUserFanoutTargetsCache('chan-3');
    expect(redis.del).toHaveBeenCalledWith('channel:chan-3:user_fanout_targets');
  });

  it('invalidateCommunityChannelUserFanoutTargetsCache deletes cached audiences for all community channels', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'chan-4' }, { id: 'chan-5' }],
    });

    await invalidateCommunityChannelUserFanoutTargetsCache('community-1');

    expect(redis.del).toHaveBeenCalledWith(
      'channel:chan-4:user_fanout_targets',
      'channel:chan-5:user_fanout_targets',
    );
  });

  it('publishChannelMessageCreated publishes channel topic then all visible member user targets', async () => {
    redis.get.mockResolvedValueOnce(null);
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(fanout.publish).toHaveBeenCalledTimes(3);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
      'channel:c1',
      'user:a',
      'user:b',
    ]);
  });

  it('publishChannelMessageCreated skips user topics when CHANNEL_MESSAGE_USER_FANOUT=0', async () => {
    const prev = process.env.CHANNEL_MESSAGE_USER_FANOUT;
    process.env.CHANNEL_MESSAGE_USER_FANOUT = '0';
    try {
      await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
      expect(fanout.publish).toHaveBeenCalledTimes(1);
      expect(fanout.publish.mock.calls[0][0]).toBe('channel:c1');
    } finally {
      if (prev === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT = prev;
    }
  });
});
