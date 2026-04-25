jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  mget: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
  pipeline: jest.fn(() => {
    const chain = {
      set: jest.fn().mockReturnThis(),
      del: jest.fn().mockReturnThis(),
      hset: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    return chain;
  }),
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(),
}));

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('../src/utils/overload', () => ({
  shouldThrottlePresenceFanout: jest.fn(() => false),
  shouldSkipPresenceMirror: jest.fn(() => true),
}));

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../src/utils/metrics', () => ({
  presenceFanoutTotal: {
    inc: jest.fn(),
  },
}));

const redis = require('../src/db/redis') as {
  get: jest.Mock;
  mget: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
  pipeline: jest.Mock;
};
const pool = require('../src/db/pool') as {
  query: jest.Mock;
};
const { publishUserFeedTargets } = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: jest.Mock;
};
const { setPresence } = require('../src/presence/service') as {
  setPresence: (userId: string, status: string, awayMessage?: string | null) => Promise<void>;
};

describe('presence fanout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.mget.mockResolvedValue([null, null]);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.eval.mockResolvedValue(1);
  });

  it('deduplicates recipients across shared communities and conversations', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          { target_type: 'community', target_id: '11111111-1111-1111-1111-111111111111' },
          { target_type: 'conversation', target_id: '22222222-2222-2222-2222-222222222222' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
          { user_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
        ],
      });

    await setPresence(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'away',
      'presence regression test',
    );

    expect(publishUserFeedTargets).toHaveBeenCalledTimes(1);
    expect(publishUserFeedTargets).toHaveBeenCalledWith(
      [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      ],
      {
        event: 'presence:updated',
        data: {
          userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          status: 'away',
          awayMessage: 'presence regression test',
        },
      },
    );
  });
});
