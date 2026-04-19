jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(() => Promise.resolve(null)),
  mget: jest.fn(() => Promise.resolve([null, null])),
  set: jest.fn(() => Promise.resolve('OK')),
  del: jest.fn(() => Promise.resolve(1)),
  pipeline: jest.fn(() => ({
    del: jest.fn().mockReturnThis(),
    incr: jest.fn().mockReturnThis(),
    exec: jest.fn(() => Promise.resolve([[null, 1], [null, 1]])),
  })),
}));

jest.mock('../src/utils/metrics', () => ({
  fanoutTargetCacheTotal: {
    inc: jest.fn(),
  },
  conversationFanoutTargetsCacheVersionRetryTotal: {
    inc: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query } = require('../src/db/pool') as { query: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  mget: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  pipeline: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getConversationFanoutTargets,
  invalidateConversationFanoutTargetsCache,
} = require('../src/messages/conversationFanoutTargets') as {
  getConversationFanoutTargets: (conversationId: string) => Promise<string[]>;
  invalidateConversationFanoutTargetsCache: (conversationId: string) => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const metrics = require('../src/utils/metrics') as {
  fanoutTargetCacheTotal: { inc: jest.Mock };
  conversationFanoutTargetsCacheVersionRetryTotal: { inc: jest.Mock };
};

describe('conversationFanoutTargets', () => {
  afterEach(() => {
    query.mockReset();
    redis.get.mockReset();
    redis.mget.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.pipeline.mockReset();
    redis.get.mockResolvedValue(null);
    redis.mget.mockResolvedValue([null, null]);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.pipeline.mockImplementation(() => ({
      del: jest.fn().mockReturnThis(),
      incr: jest.fn().mockReturnThis(),
      exec: jest.fn(() => Promise.resolve([[null, 1], [null, 1]])),
    }));
    metrics.fanoutTargetCacheTotal.inc.mockReset();
    metrics.conversationFanoutTargetsCacheVersionRetryTotal.inc.mockReset();
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
    redis.mget
      .mockResolvedValueOnce([null, null])
      .mockResolvedValueOnce([JSON.stringify(['conversation:conv-2', 'user:a', 'user:b']), '0']);
    redis.get
      .mockResolvedValueOnce('0');
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
    expect(redis.pipeline).toHaveBeenCalled();
    const pipe = redis.pipeline.mock.results[0].value;
    expect(pipe.del).toHaveBeenCalledWith('conversation:conv-3:fanout_targets');
    expect(pipe.incr).toHaveBeenCalledWith('conversation:conv-3:fanout_targets_v');
    expect(pipe.exec).toHaveBeenCalled();
  });

  it('retries load when fanout version changes during the PG round-trip', async () => {
    redis.mget
      .mockResolvedValueOnce([null, '0']);
    redis.get
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('1');
    query
      .mockResolvedValueOnce({ rows: [{ user_id: 'a' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'a' }, { user_id: 'b' }] });

    const targets = await getConversationFanoutTargets('conv-4');

    expect(query).toHaveBeenCalledTimes(2);
    expect(targets).toEqual(['conversation:conv-4', 'user:a', 'user:b']);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(metrics.conversationFanoutTargetsCacheVersionRetryTotal.inc).toHaveBeenCalledWith({
      outcome: 'retry',
    });
  });
});
