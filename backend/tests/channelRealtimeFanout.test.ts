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

jest.mock('../src/messages/realtimePending', () => ({
  enqueuePendingMessageForUsers: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  mget: jest.fn(() => Promise.resolve([])),
  zrangebyscore: jest.fn(() => Promise.resolve([])),
  set: jest.fn(() => Promise.resolve('OK')),
  del: jest.fn(() => Promise.resolve(1)),
  incr: jest.fn(() => Promise.resolve(1)),
  pipeline: jest.fn(),
  multi: jest.fn(() => ({
    zremrangebyscore: jest.fn().mockReturnThis(),
    zadd: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn(() => Promise.resolve([])),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fanout = require('../src/websocket/fanout') as { publish: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  mget: jest.Mock;
  zrangebyscore: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  incr: jest.Mock;
  pipeline: jest.Mock;
  multi: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { userFeedRedisChannelForUserId } = require('../src/websocket/userFeed') as {
  userFeedRedisChannelForUserId: (userId: string) => string;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { enqueuePendingMessageForUsers } = require('../src/messages/realtimePending') as {
  enqueuePendingMessageForUsers: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  publishChannelMessageCreated,
  publishChannelMessageRecentUserBridge,
  getChannelUserFanoutTargetKeys,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
} = require('../src/messages/channelRealtimeFanout') as {
  publishChannelMessageCreated: (channelId: string, envelope: Record<string, unknown>) => Promise<void>;
  publishChannelMessageRecentUserBridge: (channelId: string, envelope: Record<string, unknown>) => Promise<{ targetCount: number }>;
  getChannelUserFanoutTargetKeys: (channelId: string) => Promise<string[]>;
  invalidateChannelUserFanoutTargetsCache: (channelId: string) => Promise<void>;
  invalidateCommunityChannelUserFanoutTargetsCache: (communityId: string) => Promise<void>;
};

describe('channelRealtimeFanout', () => {
  let pipelineDel: jest.Mock;
  let pipelineIncr: jest.Mock;
  let pipelineSet: jest.Mock;
  let pipelineZadd: jest.Mock;
  let pipelineExpire: jest.Mock;
  let pipelineExec: jest.Mock;

  beforeEach(() => {
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'false';
  });

  afterEach(() => {
    query.mockReset();
    fanout.publish.mockReset();
    redis.get.mockReset();
    redis.mget.mockReset();
    redis.zrangebyscore.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.incr.mockReset();
    redis.pipeline.mockReset();
    redis.multi.mockReset();
    enqueuePendingMessageForUsers.mockReset();
    enqueuePendingMessageForUsers.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null);
    redis.mget.mockResolvedValue([]);
    redis.zrangebyscore.mockResolvedValue([]);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.incr.mockResolvedValue(1);
    pipelineDel = jest.fn();
    pipelineIncr = jest.fn();
    pipelineSet = jest.fn();
    pipelineZadd = jest.fn();
    pipelineExpire = jest.fn();
    pipelineExec = jest.fn(() => Promise.resolve([]));
    const pipelineObj: any = {
      del: (...args: any[]) => { pipelineDel(...args); return pipelineObj; },
      incr: (...args: any[]) => { pipelineIncr(...args); return pipelineObj; },
      set: (...args: any[]) => { pipelineSet(...args); return pipelineObj; },
      zadd: (...args: any[]) => { pipelineZadd(...args); return pipelineObj; },
      expire: (...args: any[]) => { pipelineExpire(...args); return pipelineObj; },
      exec: pipelineExec,
    };
    redis.pipeline.mockReturnValue(pipelineObj);
    redis.multi.mockReturnValue({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn(() => Promise.resolve([])),
    });
    delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    delete process.env.CHANNEL_RECENT_ZSET_ENABLED;
  });

  it('getChannelUserFanoutTargetKeys returns distinct user: keys from query rows', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u1' }],
    });
    const keys = await getChannelUserFanoutTargetKeys('chan-1');
    expect(keys).toEqual(['user:u1', 'user:u2']);
  });

  it('getChannelUserFanoutTargetKeys reuses cached user fanout targets', async () => {
    redis.mget
      .mockResolvedValueOnce([null, '0'])
      .mockResolvedValueOnce([JSON.stringify({ v: 2, u: ['cached-a', 'cached-b'] }), '0']);
    redis.get
      .mockResolvedValueOnce('0');
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
      JSON.stringify({ v: 2, u: ['cached-a', 'cached-b'] }),
      'EX',
      180,
    );
  });

  it('invalidateChannelUserFanoutTargetsCache deletes the cached audience for one channel', async () => {
    await invalidateChannelUserFanoutTargetsCache('chan-3');
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(pipelineDel).toHaveBeenCalledWith('channel:chan-3:user_fanout_targets');
    expect(pipelineIncr).toHaveBeenCalledWith('channel:chan-3:user_fanout_targets_v');
    expect(pipelineExec).toHaveBeenCalledTimes(1);
  });

  it('invalidateCommunityChannelUserFanoutTargetsCache deletes cached audiences for all community channels', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'chan-4' }, { id: 'chan-5' }],
    });

    await invalidateCommunityChannelUserFanoutTargetsCache('community-1');

    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(pipelineDel).toHaveBeenNthCalledWith(1, 'channel:chan-4:user_fanout_targets');
    expect(pipelineIncr).toHaveBeenNthCalledWith(1, 'channel:chan-4:user_fanout_targets_v');
    expect(pipelineDel).toHaveBeenNthCalledWith(2, 'channel:chan-5:user_fanout_targets');
    expect(pipelineIncr).toHaveBeenNthCalledWith(2, 'channel:chan-5:user_fanout_targets_v');
    expect(pipelineExec).toHaveBeenCalledTimes(1);
  });

  it('publishChannelMessageCreated publishes all visible member user targets by default', async () => {
    redis.mget.mockResolvedValueOnce([null, null]);
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
      ['user:a', 'user:b'],
      expect.objectContaining({ event: 'message:created', data: expect.objectContaining({ id: 'm1' }) }),
    );
    const expectedChannels = [
      'channel:c1',
      userFeedRedisChannelForUserId('a'),
      userFeedRedisChannelForUserId('b'),
    ].sort();
    expect(fanout.publish).toHaveBeenCalledTimes(new Set(expectedChannels).size);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
  });

  it('publishChannelMessageCreated fast-paths only recent-connect user targets when opted in', async () => {
    const prev = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    try {
      redis.mget
        .mockResolvedValueOnce([null, null])
        .mockResolvedValueOnce(['1', null]);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
      await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledTimes(1);
      const pendingArg = enqueuePendingMessageForUsers.mock.calls[0][0] as string[];
      expect(pendingArg.sort()).toEqual(['user:a', 'user:b']);
      const expectedChannels = [
        'channel:c1',
        userFeedRedisChannelForUserId('a'),
      ].sort();
      expect(fanout.publish).toHaveBeenCalledTimes(new Set(expectedChannels).size);
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    } finally {
      if (prev === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prev;
    }
  });

  it('publishChannelMessageCreated recent_connect uses per-channel ZSET when CHANNEL_RECENT_ZSET_ENABLED', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-1';
    try {
      // First mget: cache state check; second mget: ws:recent_connect fallback for user 'b' (not in ZSET)
      redis.mget
        .mockResolvedValueOnce([null, null])
        .mockResolvedValueOnce([null]);
      redis.zrangebyscore.mockResolvedValueOnce(['a']);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
      await publishChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
      const expectedChannels = [
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort();
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated recent_connect ZSET includes bootstrap-window users via ws:recent_connect fallback', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-bootstrap';
    try {
      // User 'a' is in channel ZSET; user 'b' is NOT in ZSET but has ws:recent_connect set
      // (bootstrap timing window: user connected but markChannelRecentConnect hasn't run yet)
      redis.mget
        .mockResolvedValueOnce([null, null])  // cache state check
        .mockResolvedValueOnce(['1']);         // ws:recent_connect:b → present
      redis.zrangebyscore.mockResolvedValueOnce(['a']);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
      await publishChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
      const expectedChannels = [
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
        userFeedRedisChannelForUserId('b'),
      ].sort();
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated falls back to capped targets when ZSET recent-connect lookup fails', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-fail-1';
    try {
      redis.mget.mockResolvedValueOnce([null, null]);
      redis.zrangebyscore.mockRejectedValueOnce(new Error('redis zrange failed'));
      query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
      await publishChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      const expectedChannels = [
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
        userFeedRedisChannelForUserId('b'),
      ].sort();
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated falls back to full user fanout when recent-connect lookup fails', async () => {
    redis.mget
      .mockResolvedValueOnce([null, null])
      .mockRejectedValueOnce(new Error('redis mget failed'));
    query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
    await publishChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    const expectedChannels = [
      'channel:c1',
      userFeedRedisChannelForUserId('a'),
      userFeedRedisChannelForUserId('b'),
    ].sort();
    expect(fanout.publish).toHaveBeenCalledTimes(new Set(expectedChannels).size);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
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

  it('publishChannelMessageRecentUserBridge immediately publishes only recent channel users', async () => {
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    redis.zrangebyscore.mockResolvedValueOnce(['a', 'b', 'a']);

    const result = await publishChannelMessageRecentUserBridge('bridge-1', {
      event: 'message:created',
      data: { id: 'm-bridge-1' },
    });

    const expectedChannels = [
      userFeedRedisChannelForUserId('a'),
      userFeedRedisChannelForUserId('b'),
    ].sort();
    expect(result.targetCount).toBe(2);
    expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
  });
});
