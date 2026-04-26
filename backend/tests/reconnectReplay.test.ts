jest.mock('../src/db/pool', () => ({
  withTransaction: jest.fn(),
  poolStats: jest.fn(() => ({ waiting: 0, total: 1, idle: 1, max: 25 })),
}));

jest.mock('../src/utils/overload', () => ({
  getStage: jest.fn(() => 0),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() })),
}));

jest.mock('../src/db/redis', () => {
  const store = new Map<string, { val: string; exp: number }>();
  const api = {
    status: 'ready' as const,
    get: jest.fn(async (key: string) => {
      const row = store.get(key);
      if (!row) return null;
      if (Date.now() > row.exp) {
        store.delete(key);
        return null;
      }
      return row.val;
    }),
    set: jest.fn(async (key: string, val: string, _mode: string, ttlSec: string | number) => {
      const ttl = typeof ttlSec === 'string' ? parseInt(ttlSec, 10) : ttlSec;
      store.set(key, { val, exp: Date.now() + Number(ttl) * 1000 });
      return 'OK';
    }),
  };
  (globalThis as unknown as { __wsReplayRedisTestHarness: { store: typeof store; clear: () => void } }).__wsReplayRedisTestHarness = {
    store,
    clear: () => store.clear(),
  };
  return { __esModule: true, default: api };
});

jest.mock('../src/utils/metrics', () => ({
  wsReplayQueryTotal: { inc: jest.fn() },
  wsReplayQueryDurationMs: { observe: jest.fn() },
  wsReplayErrorClassTotal: { inc: jest.fn() },
  wsReplayFailOpenTotal: { inc: jest.fn() },
  wsReplayDedupedTotal: { inc: jest.fn() },
  wsReplayCachedTotal: { inc: jest.fn() },
  wsReplayDbQueryTotal: { inc: jest.fn() },
  wsReplayStartedTotal: { inc: jest.fn() },
  messageChannelInsertLockPressureWaitP95MsGauge: { set: jest.fn() },
  messageChannelInsertLockPressureRecentTimeoutsGauge: { set: jest.fn() },
}));

const { withTransaction } = require('../src/db/pool') as { withTransaction: jest.Mock };
const overload = require('../src/utils/overload') as { getStage: jest.Mock };
const logger = require('../src/utils/logger') as { warn: jest.Mock };
const metrics = require('../src/utils/metrics') as {
  wsReplayQueryTotal: { inc: jest.Mock };
  wsReplayQueryDurationMs: { observe: jest.Mock };
  wsReplayErrorClassTotal: { inc: jest.Mock };
  wsReplayDedupedTotal: { inc: jest.Mock };
  wsReplayCachedTotal: { inc: jest.Mock };
  wsReplayDbQueryTotal: { inc: jest.Mock };
  wsReplayStartedTotal: { inc: jest.Mock };
};

function redisTestHarness() {
  return (globalThis as unknown as { __wsReplayRedisTestHarness: { clear: () => void } }).__wsReplayRedisTestHarness;
}

const {
  loadReplayableMessagesForUser,
  resetReplayDedupeMemForTests,
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED,
} = require('../src/messages/reconnectReplay') as {
  loadReplayableMessagesForUser: (
    userId: string,
    disconnectedAtMs: number,
    reconnectObservedAtMs: number,
    closeCode?: number,
  ) => Promise<any[]>;
  resetReplayDedupeMemForTests: () => void;
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS: number;
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED: number;
};

describe('reconnectReplay bounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
    redisTestHarness()?.clear();
    resetReplayDedupeMemForTests();
  });

  it('skips replay entirely at overload stage 3', async () => {
    overload.getStage.mockReturnValue(3);

    const rows = await loadReplayableMessagesForUser('user-1', 1_000, 3_000);

    expect(rows).toEqual([]);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'skipped' });
    expect(metrics.wsReplayStartedTotal.inc).not.toHaveBeenCalled();
    expect(metrics.wsReplayDbQueryTotal.inc).not.toHaveBeenCalled();
  });

  it('uses a short local statement timeout and tighter bounds under stage 2', async () => {
    overload.getStage.mockReturnValue(2);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any[]>) => {
      const client = {
        query: jest
          .fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [{ id: 'msg-1', content: 'replayed' }] }),
      };
      recordedClient = client;
      return run(client);
    });

    const disconnectedAtMs = 1_000_000;
    const reconnectObservedAtMs = 1_020_000;
    const rows = await loadReplayableMessagesForUser('user-2', disconnectedAtMs, reconnectObservedAtMs);

    expect(rows).toEqual([{ id: 'msg-1', content: 'replayed' }]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayStartedTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayDbQueryTotal.inc).toHaveBeenCalledTimes(1);
    expect(recordedClient?.query).toHaveBeenNthCalledWith(
      1,
      `SET LOCAL statement_timeout = '${WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS_CAPPED}ms'`,
    );
    const replayQueryArgs = recordedClient?.query.mock.calls[1];
    expect(String(replayQueryArgs?.[0] || '')).toContain('conversation_candidates');
    expect(String(replayQueryArgs?.[0] || '')).toContain('channel_candidates');
    expect(String(replayQueryArgs?.[0] || '')).toContain('UNION ALL');
    expect(replayQueryArgs?.[1]).toEqual([
      'user-2',
      disconnectedAtMs - WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
      disconnectedAtMs + 12_000,
      10,
      50,
    ]);
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('fails replay open on statement timeout instead of surfacing an error', async () => {
    withTransaction.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );

    const rows = await loadReplayableMessagesForUser('user-3', 5_000, 25_000);

    expect(rows).toEqual([]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'timeout' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-3',
        replayLimit: expect.any(Number),
        replayAttempt: 1,
        overloadStage: 0,
      }),
      'WS reconnect replay skipped after bounded DB failure',
    );
  });

  it('does not retry after the first replay timeout', async () => {
    withTransaction.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );

    const disconnectedAtMs = 5_000_000;
    const reconnectObservedAtMs = 5_030_000;
    const rows = await loadReplayableMessagesForUser('user-retry', disconnectedAtMs, reconnectObservedAtMs);

    expect(rows).toEqual([]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'timeout' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-retry',
        replayAttempt: 1,
      }),
      'WS reconnect replay skipped after bounded DB failure',
    );
  });
});

describe('reconnectReplay dedupe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
    redisTestHarness()?.clear();
    resetReplayDedupeMemForTests();
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any[]>) => {
      const client = {
        query: jest
          .fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [{ id: 'm1' }] }),
      };
      return run(client);
    });
  });

  const baseArgs = ['user-dedupe', 1_000_000, 1_000_050, 1005] as const;

  it('first replay hits DB', async () => {
    const rows = await loadReplayableMessagesForUser(...baseArgs);
    expect(rows).toEqual([{ id: 'm1' }]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayDedupedTotal.inc).not.toHaveBeenCalled();
    expect(metrics.wsReplayDbQueryTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('immediate duplicate replay is skipped', async () => {
    await loadReplayableMessagesForUser(...baseArgs);
    jest.clearAllMocks();
    const rows = await loadReplayableMessagesForUser(...baseArgs);
    expect(rows).toEqual([{ id: 'm1' }]);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(metrics.wsReplayCachedTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayDbQueryTotal.inc).not.toHaveBeenCalled();
  });

  it('replay after TTL hits DB again', async () => {
    await loadReplayableMessagesForUser(...baseArgs);
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
    try {
      const rows = await loadReplayableMessagesForUser(...baseArgs);
      expect(rows).toEqual([{ id: 'm1' }]);
      expect(withTransaction).toHaveBeenCalledTimes(1);
      expect(metrics.wsReplayDedupedTotal.inc).not.toHaveBeenCalled();
      expect(metrics.wsReplayDbQueryTotal.inc).toHaveBeenCalledTimes(1);
    } finally {
      (Date.now as jest.Mock).mockRestore?.();
    }
  });

  it('different user is not skipped', async () => {
    await loadReplayableMessagesForUser(...baseArgs);
    jest.clearAllMocks();
    const rows = await loadReplayableMessagesForUser('other-user', 1_000_000, 1_000_050, 1005);
    expect(rows).toEqual([{ id: 'm1' }]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayDedupedTotal.inc).not.toHaveBeenCalled();
  });

  it('changed cursor/window is not skipped', async () => {
    await loadReplayableMessagesForUser(...baseArgs);
    jest.clearAllMocks();
    const rows = await loadReplayableMessagesForUser('user-dedupe', 1_000_000, 1_000_080, 1005);
    expect(rows).toEqual([{ id: 'm1' }]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(metrics.wsReplayDedupedTotal.inc).not.toHaveBeenCalled();
  });
});
