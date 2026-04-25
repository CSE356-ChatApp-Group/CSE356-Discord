jest.mock('../src/db/pool', () => ({
  query: jest.fn(() => new Promise(() => {})),
  queryRead: jest.fn(() => new Promise(() => {})),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  mget: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query, queryRead } = require('../src/db/pool') as {
  query: jest.Mock;
  queryRead: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  mget: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
} = require('../src/messages/accessCaches') as {
  channelIdIfOnlyConversationQueryParam: (uuid: string, userId: string) => Promise<string | null>;
  loadMessageTargetForUser: (
    messageId: string,
    userId: string,
    options?: { preferCache?: boolean },
  ) => Promise<any>;
};

describe('accessCaches version-aware invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.del.mockResolvedValue(1);
    redis.set.mockResolvedValue('OK');
  });

  it('serves ch_compat cache only when channel access version matches', async () => {
    redis.mget.mockResolvedValueOnce([
      JSON.stringify({ channelId: 'channel-1', version: 7 }),
      '7',
    ]);

    const result = await channelIdIfOnlyConversationQueryParam('channel-1', 'user-1');

    expect(result).toBe('channel-1');
    expect(query).not.toHaveBeenCalled();
  });

  it('invalidates stale ch_compat cache when channel access version changed', async () => {
    redis.mget.mockResolvedValueOnce([
      JSON.stringify({ channelId: null, version: 1 }),
      '2',
    ]);
    query.mockResolvedValueOnce({ rows: [{ id: 'channel-now-visible' }] });
    redis.get.mockResolvedValueOnce('2');

    const result = await channelIdIfOnlyConversationQueryParam('channel-2', 'user-2');

    expect(result).toBe('channel-now-visible');
    expect(redis.del).toHaveBeenCalledWith('ch_compat:channel-2:user-2');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('serves msg_target cache only when access scope version matches', async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({
        data: { id: 'm-1', has_access: true, channel_id: 'channel-1' },
        scope: { kind: 'channel', id: 'channel-1' },
        version: 4,
      }))
      .mockResolvedValueOnce('4');

    // queryRead will be called because it races concurrently with the cache.
    // We mock it to return something, though the cache result should win the race in this test.
    queryRead.mockResolvedValueOnce({
      rows: [{ id: 'm-1', has_access: true, channel_id: 'channel-1' }],
    });

    const result = await loadMessageTargetForUser('m-1', 'user-1');

    expect(result).toEqual({ id: 'm-1', has_access: true, channel_id: 'channel-1' });
    expect(queryRead).toHaveBeenCalledTimes(1);
  });

  it('avoids the replica query on fresh msg_target cache hits when preferCache is enabled', async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({
        data: { id: 'm-hot', has_access: true, channel_id: 'channel-hot' },
        scope: { kind: 'channel', id: 'channel-hot' },
        version: 9,
      }))
      .mockResolvedValueOnce('9');

    const result = await loadMessageTargetForUser('m-hot', 'user-hot', {
      preferCache: true,
    });

    expect(result).toEqual({
      id: 'm-hot',
      has_access: true,
      channel_id: 'channel-hot',
    });
    expect(queryRead).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('falls back to primary when the read replica misses a fresh message target', async () => {
    redis.get.mockResolvedValue(null);
    queryRead.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({
      rows: [{
        id: 'm-fresh',
        has_access: true,
        channel_id: 'channel-fresh',
        conversation_id: null,
        community_id: 'community-fresh',
      }],
    });

    const result = await loadMessageTargetForUser('m-fresh', 'user-fresh');

    expect(queryRead).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: 'm-fresh',
      has_access: true,
      channel_id: 'channel-fresh',
    });
  });

  it('bypasses stale msg_target cache when access scope version changed', async () => {
    redis.get
      .mockResolvedValueOnce(JSON.stringify({
        data: { id: 'm-2', has_access: true, conversation_id: 'conv-1' },
        scope: { kind: 'conversation', id: 'conv-1' },
        version: 3,
      }))
      .mockResolvedValueOnce('4')
      .mockResolvedValueOnce('4');
    queryRead.mockResolvedValueOnce({
      rows: [{
        id: 'm-2',
        has_access: false,
        conversation_id: 'conv-1',
        channel_id: null,
      }],
    });

    const result = await loadMessageTargetForUser('m-2', 'user-2');

    expect(redis.del).toHaveBeenCalledWith('msg_target:m-2:user-2');
    expect(queryRead).toHaveBeenCalledTimes(1);
    expect(result.has_access).toBe(false);
  });
});
