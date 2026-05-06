jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  poolStats: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  incr: jest.fn(),
  decr: jest.fn(),
  set: jest.fn(),
  eval: jest.fn(),
  expire: jest.fn(),
}));

jest.mock('../src/messages/sideEffects', () => ({
  enqueueFanoutJob: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), debug: jest.fn() })),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const redis = require('../src/db/redis') as {
  incr: jest.Mock;
  decr: jest.Mock;
  set: jest.Mock;
  eval: jest.Mock;
  expire: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { query, poolStats } = require('../src/db/pool') as {
  query: jest.Mock;
  poolStats: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sideEffects = require('../src/messages/sideEffects') as { enqueueFanoutJob: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  incrementChannelMessageCount,
  decrementChannelMessageCount,
} = require('../src/messages/channelMessageCounter') as {
  incrementChannelMessageCount: (channelId: string) => Promise<void>;
  decrementChannelMessageCount: (channelId: string) => Promise<void>;
};

describe('channelMessageCounter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    poolStats.mockReturnValue({ waiting: 0 });
    redis.eval.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    sideEffects.enqueueFanoutJob.mockImplementation((_name, fn) => {
      Promise.resolve().then(fn);
      return true;
    });
  });

  it('keeps hot increment path Redis-only when key already exists', async () => {
    redis.incr.mockResolvedValue(25);

    await incrementChannelMessageCount('chan-hot');

    expect(redis.incr).toHaveBeenCalledWith('channel:msg_count:chan-hot');
    expect(redis.expire).toHaveBeenCalledWith('channel:msg_count:chan-hot', 2_592_000);
    expect(sideEffects.enqueueFanoutJob).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('schedules background reconciliation on cold increment without blocking request path', async () => {
    redis.incr.mockResolvedValue(1);
    redis.set.mockImplementation(async (key: string, ...args: any[]) => {
      if (key === 'channel:msg_count:reconcile:cooldown:chan-cold') return 'OK';
      if (key === 'channel:msg_count:reconcile:lock:chan-cold') return 'OK';
      if (key === 'channel:msg_count:chan-cold') return 'OK';
      return null;
    });
    query.mockResolvedValue({ rows: [{ cnt: 37 }] });

    await incrementChannelMessageCount('chan-cold');
    await new Promise((resolve) => setImmediate(resolve));

    expect(sideEffects.enqueueFanoutJob).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT COUNT(*)::int AS cnt FROM messages WHERE channel_id = $1 AND deleted_at IS NULL',
      ['chan-cold'],
    );
    expect(redis.set).toHaveBeenCalledWith('channel:msg_count:chan-cold', '37', 'EX', 2_592_000);
  });

  it('clamps missing-key decrement and schedules reconciliation', async () => {
    redis.decr.mockResolvedValue(-1);
    redis.set.mockImplementation(async (key: string, ...args: any[]) => {
      if (key === 'channel:msg_count:chan-del') return 'OK';
      if (key === 'channel:msg_count:reconcile:cooldown:chan-del') return 'OK';
      if (key === 'channel:msg_count:reconcile:lock:chan-del') return 'OK';
      return null;
    });
    query.mockResolvedValue({ rows: [{ cnt: 12 }] });

    await decrementChannelMessageCount('chan-del');
    await new Promise((resolve) => setImmediate(resolve));

    expect(redis.set).toHaveBeenCalledWith('channel:msg_count:chan-del', '0', 'EX', 2_592_000);
    expect(query).toHaveBeenCalledWith(
      'SELECT COUNT(*)::int AS cnt FROM messages WHERE channel_id = $1 AND deleted_at IS NULL',
      ['chan-del'],
    );
  });
});
