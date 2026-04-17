jest.mock('../src/db/pool', () => ({
  withTransaction: jest.fn(),
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

jest.mock('../src/utils/metrics', () => ({
  wsReplayQueryTotal: { inc: jest.fn() },
  wsReplayQueryDurationMs: { observe: jest.fn() },
}));

const { withTransaction } = require('../src/db/pool') as { withTransaction: jest.Mock };
const overload = require('../src/utils/overload') as { getStage: jest.Mock };
const logger = require('../src/utils/logger') as { warn: jest.Mock };
const metrics = require('../src/utils/metrics') as {
  wsReplayQueryTotal: { inc: jest.Mock };
  wsReplayQueryDurationMs: { observe: jest.Mock };
};

const {
  loadReplayableMessagesForUser,
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS,
} = require('../src/messages/reconnectReplay') as {
  loadReplayableMessagesForUser: (
    userId: string,
    disconnectedAtMs: number,
    reconnectObservedAtMs: number,
  ) => Promise<any[]>;
  WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS: number;
  WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS: number;
};

describe('reconnectReplay bounds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
  });

  it('skips replay entirely at overload stage 3', async () => {
    overload.getStage.mockReturnValue(3);

    const rows = await loadReplayableMessagesForUser('user-1', 1_000, 3_000);

    expect(rows).toEqual([]);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'skipped' });
  });

  it('uses a short local statement timeout and tighter bounds under stage 2', async () => {
    overload.getStage.mockReturnValue(2);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any[]>) => {
      const client = {
        query: jest.fn()
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
    expect(recordedClient?.query).toHaveBeenNthCalledWith(
      1,
      `SET LOCAL statement_timeout = ${WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS}`,
    );
    const replayQueryArgs = recordedClient?.query.mock.calls[1];
    expect(replayQueryArgs?.[1]).toEqual([
      'user-2',
      disconnectedAtMs - WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS,
      disconnectedAtMs + 15_000,
      40,
    ]);
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('fails replay open on statement timeout instead of surfacing an error', async () => {
    withTransaction.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );

    const rows = await loadReplayableMessagesForUser('user-3', 5_000, 25_000);

    expect(rows).toEqual([]);
    expect(metrics.wsReplayQueryTotal.inc).toHaveBeenCalledWith({ result: 'timeout' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-3',
        replayLimit: expect.any(Number),
        overloadStage: 0,
      }),
      'WS reconnect replay skipped after bounded DB failure',
    );
  });
});
