const { replayPendingMessagesToSocket } = require('../src/websocket/replay');

describe('pending replay reconnect window', () => {
  function buildDeps(overrides = {}) {
    return {
      drainPendingMessagesForUser: jest.fn().mockResolvedValue([]),
      sendPayloadToSocket: jest.fn(),
      WS_REPLAY_OUTBOUND_YIELD_EVERY: 48,
      WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS: 5000,
      ...overrides,
    };
  }

  it('drains only the reconnect gap plus grace when disconnect metadata is available', async () => {
    const deps = buildDeps();
    const ws = { readyState: 1 };

    await replayPendingMessagesToSocket(
      deps,
      ws,
      'user-1',
      { disconnectedAt: 20_000 },
      25_000,
    );

    expect(deps.drainPendingMessagesForUser).toHaveBeenCalledWith('user-1', {
      minScoreMs: 15_000,
      maxScoreMs: 25_000,
    });
  });

  it('keeps legacy full pending drain when called without a reconnect window', async () => {
    const deps = buildDeps();
    const ws = { readyState: 1 };

    await replayPendingMessagesToSocket(deps, ws, 'user-1');

    expect(deps.drainPendingMessagesForUser).toHaveBeenCalledWith('user-1', {});
  });
});
