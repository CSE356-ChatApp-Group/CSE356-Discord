import { createRequire } from 'module';

const cjsRequire = createRequire(__filename);

const {
  createDisconnectLifecycle,
  classifyDisconnectReason,
} = cjsRequire('../src/websocket/disconnectLifecycle');

describe('classifyDisconnectReason', () => {
  it('classifies heartbeat timeouts distinctly', () => {
    expect(
      classifyDisconnectReason({
        closeCode: 1006,
        closeReason: 'heartbeat_timeout',
        clean: false,
        sawError: false,
        shuttingDown: false,
      }),
    ).toBe('heartbeat_timeout');
  });

  it('classifies auth revocations distinctly', () => {
    expect(
      classifyDisconnectReason({
        closeCode: 4001,
        closeReason: 'Unauthorized',
        clean: true,
        sawError: false,
        shuttingDown: false,
      }),
    ).toBe('auth_revoke');
  });
});

describe('createDisconnectLifecycle', () => {
  it('uses the disconnect reason hint when the close frame reason is empty', () => {
    const wsDisconnectsTotal = { inc: jest.fn() };
    const wsDisconnectReasonTotal = { inc: jest.fn() };
    const wsConnectionLifetimeMs = { observe: jest.fn() };
    const { cleanup } = createDisconnectLifecycle({
      WebSocket: {},
      clearOutboundQueue: jest.fn(),
      wsDisconnectsTotal,
      wsDisconnectReasonTotal,
      wsConnectionLifetimeMs,
      unsubscribeClient: jest.fn(),
      unsubscribeCommunityClient: jest.fn(),
      noteRecentDisconnectForSocket: jest.fn(),
      isRedisOperational: () => false,
      redis: {},
      removeConnection: jest.fn(),
      recomputeUserPresence: jest.fn(),
      scheduleDebouncedPresenceRecompute: jest.fn(),
      logWsHotInfo: jest.fn(),
      logger: { warn: jest.fn() },
      isShuttingDown: () => false,
    });

    cleanup(
      {
        _subscriptions: new Set(),
        _communityIds: new Set(),
        _bootstrapReady: true,
        _connectedAt: Date.now() - 1000,
        _connectionId: 'conn-1',
        _sawError: false,
        _disconnectReasonHint: 'heartbeat_timeout',
      },
      'user-1',
      1006,
      '',
    );

    expect(wsDisconnectReasonTotal.inc).toHaveBeenCalledWith({ reason: 'heartbeat_timeout' });
  });
});
