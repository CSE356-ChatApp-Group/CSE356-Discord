jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  set: jest.fn(() => Promise.resolve('OK')),
  del: jest.fn(() => Promise.resolve(1)),
}));

jest.mock('../src/utils/metrics', () => ({
  fanoutTargetCacheTotal: {
    inc: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getConversationFanoutTargets,
  invalidateConversationFanoutTargetsCache,
} = require('../src/messages/conversationFanoutTargets') as {
  getConversationFanoutTargets: (conversationId: string) => Promise<string[]>;
  invalidateConversationFanoutTargetsCache: (conversationId: string) => Promise<void>;
};

describe('conversationFanoutTargets', () => {
  afterEach(() => {
    query.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
  });

  it('returns conversation plus distinct user targets from query rows', async () => {
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u1' }],
    });

    const targets = await getConversationFanoutTargets('conv-1');

    expect(targets).toEqual([
      'conversation:conv-1',
      'user:u1',
      'user:u2',
    ]);
  });

  it('reuses cached conversation fanout targets', async () => {
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(['conversation:conv-2', 'user:a', 'user:b']));
    query.mockResolvedValueOnce({
      rows: [{ user_id: 'a' }, { user_id: 'b' }],
    });

    const first = await getConversationFanoutTargets('conv-2');
    const second = await getConversationFanoutTargets('conv-2');

    expect(first).toEqual(['conversation:conv-2', 'user:a', 'user:b']);
    expect(second).toEqual(['conversation:conv-2', 'user:a', 'user:b']);
    expect(query).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'conversation:conv-2:fanout_targets',
      JSON.stringify(['conversation:conv-2', 'user:a', 'user:b']),
      'EX',
      180,
    );
  });

  it('invalidates the cached conversation audience', async () => {
    await invalidateConversationFanoutTargetsCache('conv-3');
    expect(redis.del).toHaveBeenCalledWith('conversation:conv-3:fanout_targets');
  });
});
