jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  set: jest.fn(),
  smembers: jest.fn(),
  pipeline: jest.fn(),
  srem: jest.fn(),
  eval: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), debug: jest.fn() })),
}));

const { query } = require('../src/db/pool') as { query: jest.Mock };
const redis = require('../src/db/redis') as {
  set: jest.Mock;
  smembers: jest.Mock;
  pipeline: jest.Mock;
  srem: jest.Mock;
  eval: jest.Mock;
};

const deadlockErr = Object.assign(new Error('deadlock detected'), { code: '40P01' });

function makePipeline(results: Array<[Error | null, Record<string, string> | null]>) {
  return {
    hgetall: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(results),
  };
}

describe('batchReadState flush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    redis.smembers.mockResolvedValue([]);
    redis.srem.mockResolvedValue(1);
  });

  it('skips the flush when another worker already holds the distributed lock', async () => {
    redis.set.mockResolvedValueOnce(null);

    const { flushDirtyReadStatesToDB } = require('../src/messages/batchReadState') as {
      flushDirtyReadStatesToDB: () => Promise<void>;
    };

    await flushDirtyReadStatesToDB();

    expect(redis.smembers).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('orders batch upserts deterministically and retries once on deadlock', async () => {
    redis.smembers.mockResolvedValueOnce([
      'user-b|chan-2',
      'user-a|chan-3',
      'user-a|chan-1',
    ]);
    redis.pipeline.mockReturnValueOnce(makePipeline([
      [null, { msg_id: 'msg-2', msg_created_at: '2026-04-24T22:41:12.000Z', channel_id: 'chan-2', conversation_id: '' }],
      [null, { msg_id: 'msg-3', msg_created_at: '2026-04-24T22:41:13.000Z', channel_id: 'chan-3', conversation_id: '' }],
      [null, { msg_id: 'msg-1', msg_created_at: '2026-04-24T22:41:11.000Z', channel_id: 'chan-1', conversation_id: '' }],
    ]));
    query.mockRejectedValueOnce(deadlockErr);
    query.mockResolvedValueOnce({ rowCount: 3, rows: [] });

    const { flushDirtyReadStatesToDB } = require('../src/messages/batchReadState') as {
      flushDirtyReadStatesToDB: () => Promise<void>;
    };

    await flushDirtyReadStatesToDB();

    expect(query).toHaveBeenCalledTimes(2);
    const params = query.mock.calls[0][1];
    expect(params[0]).toEqual(['user-a', 'user-a', 'user-b']);
    expect(params[1]).toEqual(['chan-1', 'chan-3', 'chan-2']);
    expect(params[3]).toEqual(['msg-1', 'msg-3', 'msg-2']);
    expect(redis.srem).toHaveBeenCalledWith(
      'rs:dirty',
      'user-a|chan-1',
      'user-a|chan-3',
      'user-b|chan-2',
    );
  });

  it('prevents overlapping local flushes inside the same worker', async () => {
    let releaseQuery: (() => void) | null = null;
    redis.smembers.mockResolvedValueOnce(['user-a|chan-1']);
    redis.pipeline.mockReturnValueOnce(makePipeline([
      [null, { msg_id: 'msg-1', msg_created_at: '2026-04-24T22:41:11.000Z', channel_id: 'chan-1', conversation_id: '' }],
    ]));
    query.mockImplementationOnce(() => new Promise((resolve) => {
      releaseQuery = () => resolve({ rowCount: 1, rows: [] });
    }));

    const { flushDirtyReadStatesToDB } = require('../src/messages/batchReadState') as {
      flushDirtyReadStatesToDB: () => Promise<void>;
    };

    const first = flushDirtyReadStatesToDB();
    const second = flushDirtyReadStatesToDB();
    await new Promise((resolve) => setImmediate(resolve));

    expect(query).toHaveBeenCalledTimes(1);

    releaseQuery?.();
    await first;
    await second;
  });
});
