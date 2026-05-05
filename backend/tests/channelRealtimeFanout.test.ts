/**
 * Channel message:created fanout targets active/recent realtime subscribers, not offline members.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/websocket/fanout', () => {
  const fanoutPublishMock = jest.fn(() => Promise.resolve()) as unknown as jest.MockedFunction<
    (channel: string, payload: unknown) => Promise<void>
  >;
  const fanoutPublishBatchMock = jest.fn(async (entries) => {
    for (const e of entries) {
      await fanoutPublishMock(e.channel, e.payload);
    }
  });
  return { publish: fanoutPublishMock, publishBatch: fanoutPublishBatchMock };
});

jest.mock('../src/messages/sideEffects', () => ({
  enqueueFanoutJob: jest.fn((_name: string, fn: () => Promise<void>) => fn()),
}));

jest.mock('../src/messages/pending/realtimePending', () => ({
  enqueuePendingMessageForUsers: jest.fn(),
}));

jest.mock('../src/db/redisBatch', () => ({
  redisBatchSmismember: jest.fn((client, key, members) => client.call('SMISMEMBER', key, ...members)),
  redisBatchSrem: jest.fn((client, key, members) => client.srem(key, ...members)),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  mget: jest.fn(() => Promise.resolve([])),
  call: jest.fn(() => Promise.resolve([])),
  smembers: jest.fn(() => Promise.resolve([])),
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
const fanout = require('../src/websocket/fanout') as { publish: jest.Mock; publishBatch: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  mget: jest.Mock;
  call: jest.Mock;
  smembers: jest.Mock;
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
const { enqueuePendingMessageForUsers } = require('../src/messages/pending/realtimePending') as {
  enqueuePendingMessageForUsers: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  publishChannelMessageCreated,
  publishChannelMessageRecentUserBridge,
  getChannelUserFanoutTargetKeys,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
  invalidateRecentConnectTargetsCache,
} = require('../src/messages/fanout/channelRealtimeFanout') as {
  publishChannelMessageCreated: (
    channelId: string,
    envelope: Record<string, unknown>,
    opts?: { communityId?: string | null; isPrivate?: boolean | null },
  ) => Promise<void>;
  publishChannelMessageRecentUserBridge: (channelId: string, envelope: Record<string, unknown>) => Promise<{ targetCount: number }>;
  getChannelUserFanoutTargetKeys: (channelId: string) => Promise<string[]>;
  invalidateChannelUserFanoutTargetsCache: (channelId: string) => Promise<void>;
  invalidateCommunityChannelUserFanoutTargetsCache: (communityId: string) => Promise<void>;
  invalidateRecentConnectTargetsCache: (channelId: string) => void;
};

function publishPrivateChannelMessageCreated(channelId: string, envelope: Record<string, unknown>) {
  return publishChannelMessageCreated(channelId, envelope, {
    communityId: 'community-test',
    isPrivate: true,
  });
}

describe('channelRealtimeFanout', () => {
  let pipelineDel: jest.Mock;
  let pipelineIncr: jest.Mock;
  let pipelineSet: jest.Mock;
  let pipelineZadd: jest.Mock;
  let pipelineExpire: jest.Mock;
  let pipelineExec: jest.Mock;

  beforeEach(() => {
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'false';
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
  });

  afterEach(() => {
    query.mockReset();
    fanout.publish.mockReset();
    fanout.publish.mockResolvedValue(undefined);
    fanout.publishBatch.mockReset();
    fanout.publishBatch.mockImplementation(async (entries) => {
      for (const e of entries) {
        await fanout.publish(e.channel, e.payload);
      }
    });
    redis.get.mockReset();
    redis.mget.mockReset();
    redis.call.mockReset();
    redis.smembers.mockReset();
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
    redis.call.mockResolvedValue([]);
    redis.smembers.mockResolvedValue([]);
    redis.zrangebyscore.mockResolvedValue([]);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.incr.mockResolvedValue(1);
    pipelineDel = jest.fn();
    pipelineIncr = jest.fn();
    pipelineSet = jest.fn();
    pipelineZadd = jest.fn();
    pipelineExpire = jest.fn();
    const pipelineSismember = jest.fn();
    const pipelineZscore = jest.fn();
    pipelineExec = jest.fn(() => Promise.resolve([]));
    const pipelineObj: any = {
      del: (...args: any[]) => { pipelineDel(...args); return pipelineObj; },
      incr: (...args: any[]) => { pipelineIncr(...args); return pipelineObj; },
      set: (...args: any[]) => { pipelineSet(...args); return pipelineObj; },
      zadd: (...args: any[]) => { pipelineZadd(...args); return pipelineObj; },
      expire: (...args: any[]) => { pipelineExpire(...args); return pipelineObj; },
      zscore: (...args: any[]) => { pipelineZscore(...args); return pipelineObj; },
      sismember: (...args: any[]) => { pipelineSismember(...args); return pipelineObj; },
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
    delete process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
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

  it('publishChannelMessageCreated publishes only the channel topic when no active bridge targets exist', async () => {
    await publishPrivateChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(query).not.toHaveBeenCalled();
    expect(enqueuePendingMessageForUsers).not.toHaveBeenCalled();
    expect(fanout.publish).toHaveBeenCalledTimes(1);
    expect(fanout.publish.mock.calls[0][0]).toBe('channel:c1');
  });

  it('publishChannelMessageCreated does not wait for recent target lookup before channel publish', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-slow-target-lookup';
    let resolveRecent: (value: string[]) => void = () => {};
    redis.zrangebyscore.mockImplementationOnce(
      () => new Promise<string[]>((resolve) => { resolveRecent = resolve; }),
    );

    try {
      const publishPromise = publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-slow-target-lookup' },
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(fanout.publish).toHaveBeenCalledTimes(1);
      expect(fanout.publish.mock.calls[0][0]).toBe(`channel:${ch}`);
      expect(enqueuePendingMessageForUsers).not.toHaveBeenCalled();

      resolveRecent([]);
      await publishPromise;
      expect(fanout.publish.mock.calls.map((c) => c[0])).toEqual([`channel:${ch}`]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated mode=all publishes to the full visible member audience', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'all';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-all-mode';
    try {
      query.mockResolvedValueOnce({
        rows: [{ user_id: 'a' }, { user_id: 'b' }],
      });

      await publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-all-mode' },
      });

      expect(redis.zrangebyscore).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
        ['user:a', 'user:b'],
        expect.objectContaining({ event: 'message:created' }),
        { recentTargets: [] },
      );
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

  it('publishChannelMessageCreated bridges active connected channel members without enumerating offline members', async () => {
    const prev = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    try {
      redis.smembers.mockResolvedValueOnce(['a', 'b', 'offline-not-present']);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });
      await publishPrivateChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledTimes(1);
      const pendingArg = enqueuePendingMessageForUsers.mock.calls[0][0] as string[];
      expect(pendingArg.sort()).toEqual(['user:a', 'user:b']);
      expect(enqueuePendingMessageForUsers.mock.calls[0][2]).toEqual({ recentTargets: ['user:a', 'user:b'] });
      expect(query.mock.calls[0][0]).toContain('ANY($2::text[])');
      expect(query.mock.calls[0][1][1]).toEqual(['a', 'b', 'offline-not-present']);
      const expectedChannels = [
        'channel:c1',
        userFeedRedisChannelForUserId('a'),
        userFeedRedisChannelForUserId('b'),
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
      redis.zrangebyscore.mockResolvedValueOnce(['a']);
      redis.call.mockResolvedValueOnce([1]);
      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
      expect(redis.call).toHaveBeenCalledWith('SMISMEMBER', 'presence:connected_users', 'a');
      expect(query).not.toHaveBeenCalled();
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

  it('publishChannelMessageCreated with userfeed skip bridges only bootstrap-pending active users', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    const prevSkip = process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = 'true';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-bootstrap-pending-only';
    try {
      redis.zrangebyscore.mockResolvedValueOnce(['a', 'b']);
      redis.call.mockResolvedValueOnce([1, 0]);

      await publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-bootstrap-pending-only' },
      });

      expect(redis.zrangebyscore.mock.calls[0][0]).toBe(`channel:bootstrap_pending:${ch}`);
      expect(redis.call).toHaveBeenCalledWith('SMISMEMBER', 'presence:connected_users', 'a', 'b');
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
        ['user:a'],
        expect.objectContaining({ event: 'message:created' }),
        { recentTargets: ['user:a'] },
      );
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort());
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
      if (prevSkip === undefined) delete process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
      else process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = prevSkip;
    }
  });

  it('publishChannelMessageCreated with userfeed skip omits hydrated active users from userfeed bridge', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    const prevSkip = process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = 'true';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-no-bootstrap-pending';
    try {
      redis.zrangebyscore.mockResolvedValueOnce([]);

      await publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-no-bootstrap-pending' },
      });

      expect(enqueuePendingMessageForUsers).not.toHaveBeenCalled();
      expect(redis.call).not.toHaveBeenCalled();
      expect(fanout.publish.mock.calls.map((c) => c[0])).toEqual([`channel:${ch}`]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
      if (prevSkip === undefined) delete process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
      else process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = prevSkip;
    }
  });

  it('publishChannelMessageCreated with userfeed skip falls through to recent_connect when bootstrap_pending is empty', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    const prevSkip = process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
    const prevConnectedFallback = process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = 'true';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK = 'false';
    const ch = 'chan-bootstrap-pending-empty-recent-fallback';
    try {
      // bootstrap_pending ZSET returns empty (markers expired or cleared by progressive hydration)
      redis.zrangebyscore.mockResolvedValueOnce([]);
      // recent_connect ZSET still has the user (longer TTL)
      redis.zrangebyscore.mockResolvedValueOnce(['a']);
      redis.call.mockResolvedValueOnce([1]);

      await publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-bootstrap-pending-empty-recent-fallback' },
      });

      // Should have queried both bootstrap_pending and recent_connect ZSETs
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(2);
      expect(redis.zrangebyscore.mock.calls[0][0]).toBe(`channel:bootstrap_pending:${ch}`);
      expect(redis.zrangebyscore.mock.calls[1][0]).toBe(`channel:recent_connect:${ch}`);
      // Must NOT trigger expensive active-connected membership SQL
      // (smembers may fire depending on INCLUDE_CONNECTED_FALLBACK config baked at require time)
      expect(query).not.toHaveBeenCalled();
      // Should publish to userfeed for the recently connected user found via fallback
      const expectedChannels = [
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort();
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
        ['user:a'],
        expect.objectContaining({ event: 'message:created' }),
        { recentTargets: ['user:a'] },
      );
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
      if (prevSkip === undefined) delete process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
      else process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = prevSkip;
      if (prevConnectedFallback === undefined) delete process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK;
      else process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK = prevConnectedFallback;
    }
  });

  it('publishChannelMessageCreated with userfeed skip fails open when bootstrap-pending filter errors', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    const prevSkip = process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = 'true';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-bootstrap-filter-fail-open';
    try {
      redis.zrangebyscore
        .mockRejectedValueOnce(new Error('bootstrap pending zrange failed'))
        .mockResolvedValueOnce(['a']);
      redis.call.mockResolvedValueOnce([1]);

      await publishPrivateChannelMessageCreated(ch, {
        event: 'message:created',
        data: { id: 'm-bootstrap-filter-fail-open' },
      });

      expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
        ['user:a'],
        expect.objectContaining({ event: 'message:created' }),
        { recentTargets: ['user:a'] },
      );
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort());
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
      if (prevSkip === undefined) delete process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH;
      else process.env.CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH = prevSkip;
    }
  });

  it('publishChannelMessageCreated recent_connect ZSET includes active connected bootstrap-window users', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-bootstrap';
    try {
      // User 'a' is in channel ZSET; user 'b' is connected but not yet channel-subscribed.
      redis.zrangebyscore.mockResolvedValueOnce(['a']);
      redis.call.mockResolvedValueOnce([1]);
      redis.smembers.mockResolvedValueOnce(['b']);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'b' }] });
      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
      expect(redis.call).toHaveBeenCalledWith('SMISMEMBER', 'presence:connected_users', 'a');
      expect(query.mock.calls[0][1][1]).toEqual(['b']);
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

  it('publishChannelMessageCreated recent_connect includes active connected users even after recent marker expiry', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-active-user-only';
    try {
      redis.zrangebyscore.mockResolvedValueOnce([]);
      redis.smembers.mockResolvedValueOnce(['active-user']);
      query.mockResolvedValueOnce({ rows: [{ user_id: 'active-user' }] });
      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(redis.smembers).toHaveBeenCalledWith('presence:connected_users');
      const expectedChannels = [
        `channel:${ch}`,
        userFeedRedisChannelForUserId('active-user'),
      ].sort();
      expect(enqueuePendingMessageForUsers.mock.calls[0][2]).toEqual({
        recentTargets: ['user:active-user'],
      });
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated recent_connect skips ZSET users without active connections', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-active-filter';
    try {
      redis.zrangebyscore.mockResolvedValueOnce(['a', 'b']);
      redis.call.mockResolvedValueOnce([1, 0]);
      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm-active-filter' } });
      expect(redis.call).toHaveBeenCalledWith('SMISMEMBER', 'presence:connected_users', 'a', 'b');
      expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
        ['user:a'],
        expect.objectContaining({ event: 'message:created' }),
        { recentTargets: ['user:a'] },
      );
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort());
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated recent_connect invalidation refreshes stale target cache after a new channel recent-connect mark', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-recent-cache-refresh';
    try {
      redis.zrangebyscore
        .mockResolvedValueOnce(['a'])
        .mockResolvedValueOnce(['a', 'b']);
      redis.call
        .mockResolvedValueOnce([1])
        .mockResolvedValueOnce([1, 1]);

      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
      ].sort());

      fanout.publish.mockClear();
      enqueuePendingMessageForUsers.mockClear();
      invalidateRecentConnectTargetsCache(ch);

      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm2' } });
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
        `channel:${ch}`,
        userFeedRedisChannelForUserId('a'),
        userFeedRedisChannelForUserId('b'),
      ].sort());
      expect(redis.zrangebyscore).toHaveBeenCalledTimes(2);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated does not fall back to broad members when ZSET recent-connect lookup fails', async () => {
    const prevMode = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
    process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = 'recent_connect';
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    const ch = 'chan-zset-fail-1';
    try {
      redis.zrangebyscore.mockRejectedValueOnce(new Error('redis zrange failed'));
      await publishPrivateChannelMessageCreated(ch, { event: 'message:created', data: { id: 'm1' } });
      expect(query).not.toHaveBeenCalled();
      expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([`channel:${ch}`]);
    } finally {
      if (prevMode === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE = prevMode;
    }
  });

  it('publishChannelMessageCreated does not fall back to full user fanout when active lookup finds nobody', async () => {
    await publishPrivateChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
    expect(query).not.toHaveBeenCalled();
    expect(fanout.publish).toHaveBeenCalledTimes(1);
    expect(fanout.publish.mock.calls[0][0]).toBe('channel:c1');
  });

  it('publishChannelMessageCreated skips user topics when CHANNEL_MESSAGE_USER_FANOUT=0', async () => {
    const prev = process.env.CHANNEL_MESSAGE_USER_FANOUT;
    process.env.CHANNEL_MESSAGE_USER_FANOUT = '0';
    try {
      await publishPrivateChannelMessageCreated('c1', { event: 'message:created', data: { id: 'm1' } });
      expect(fanout.publish).toHaveBeenCalledTimes(1);
      expect(fanout.publish.mock.calls[0][0]).toBe('channel:c1');
    } finally {
      if (prev === undefined) delete process.env.CHANNEL_MESSAGE_USER_FANOUT;
      else process.env.CHANNEL_MESSAGE_USER_FANOUT = prev;
    }
  });

  it('publishChannelMessageRecentUserBridge immediately publishes only active recent channel users', async () => {
    process.env.CHANNEL_RECENT_ZSET_ENABLED = 'true';
    redis.zrangebyscore.mockResolvedValueOnce(['a', 'b', 'a']);
    redis.call.mockResolvedValueOnce([1, 0]);

    const result = await publishChannelMessageRecentUserBridge('bridge-1', {
      event: 'message:created',
      data: { id: 'm-bridge-1' },
    });

    const expectedChannels = [
      userFeedRedisChannelForUserId('a'),
    ].sort();
    expect(result.targetCount).toBe(1);
    expect(redis.zrangebyscore).toHaveBeenCalledTimes(1);
    expect(fanout.publish.mock.calls.map((c) => c[0]).sort()).toEqual([...new Set(expectedChannels)]);
    expect(enqueuePendingMessageForUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['user:a']),
      expect.objectContaining({ event: 'message:created' }),
      { recentTargets: expect.arrayContaining(['user:a']) },
    );
  });
});
