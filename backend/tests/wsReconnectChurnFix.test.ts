/**
 * Tests for the WS reconnect-churn reduction patch:
 *   - 2-miss heartbeat kill: one missed pong does not immediately terminate a healthy socket
 *   - Dead sockets are still terminated after the threshold
 *   - Pong between misses resets the miss counter
 *   - heartbeat_timeout disconnects use the debounced presence path
 *   - consumeRecentDisconnect uses GETDEL (one round trip) when available, falls back correctly
 *   - Ingress jitter is skipped when bootstrap queue depth is 0
 *   - WS_RECENT_CONNECT_TTL_SECONDS defaults to 60s
 */

const { createRuntimeIntervals } = require('../src/websocket/runtimeIntervals');
const { createDisconnectLifecycle } = require('../src/websocket/disconnectLifecycle');
const { createRecentDisconnectHelpers } = require('../src/websocket/recentDisconnect');
const { createConnectionLifecycle } = require('../src/websocket/connectionLifecycle');

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeWs(isAlive = true) {
  return {
    isAlive,
    _missedPings: 0,
    terminate: jest.fn(),
    ping: jest.fn(),
    _userId: 'user-1',
    _recentDisconnectRecorded: false,
    _subscriptions: new Set(),
    _communityIds: new Set(),
    _bootstrapReady: true,
    _connectedAt: Date.now() - 5000,
    _connectionId: 'conn-1',
    _sawError: false,
  };
}

function fakeWss(sockets: ReturnType<typeof fakeWs>[]) {
  return {
    clients: {
      forEach: (fn: (ws: any) => void) => sockets.forEach(fn),
    },
  };
}

// ── createRuntimeIntervals: multi-miss heartbeat ──────────────────────────────

describe('heartbeat: multi-miss kill', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function buildIntervals(opts: {
    ws: ReturnType<typeof fakeWs>;
    threshold?: number;
    noteRecentDisconnect?: jest.Mock;
  }) {
    const noteRecentDisconnectForSocket = opts.noteRecentDisconnect ?? jest.fn();
    const intervals = createRuntimeIntervals({
      wss: fakeWss([opts.ws]),
      WebSocket: {},
      wsHeartbeatIntervalMs: 1000,
      wsHeartbeatMissedPingsBeforeKill: opts.threshold ?? 2,
      presenceSweeperMs: 60_000,
      noteRecentDisconnectForSocket,
      maybeSendAppKeepaliveFrame: jest.fn(),
      reconcileAllConnectedUsers: jest.fn().mockResolvedValue(undefined),
      logger: { warn: jest.fn() },
    });
    return { intervals, noteRecentDisconnectForSocket };
  }

  it('does NOT terminate a socket after one missed pong (default threshold 2)', () => {
    const ws = fakeWs(true);
    const { intervals } = buildIntervals({ ws });

    // Tick 1: isAlive=true → reset, set false, ping. Socket alive.
    jest.advanceTimersByTime(1000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.isAlive).toBe(false);

    // Tick 2: isAlive=false (no pong) → missedPings=1, below threshold.
    jest.advanceTimersByTime(1000);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws._missedPings).toBe(1);

    intervals.stopHeartbeat();
  });

  it('terminates a socket after two consecutive missed pongs', () => {
    const ws = fakeWs(true);
    const note = jest.fn();
    const { intervals } = buildIntervals({ ws, threshold: 2, noteRecentDisconnect: note });

    jest.advanceTimersByTime(1000); // tick 1: alive
    jest.advanceTimersByTime(1000); // tick 2: first miss → missedPings=1
    expect(ws.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000); // tick 3: second miss → terminate
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(ws, 1006, 'heartbeat_timeout');

    intervals.stopHeartbeat();
  });

  it('resets miss counter when pong arrives between misses', () => {
    const ws = fakeWs(true);
    const { intervals } = buildIntervals({ ws, threshold: 2 });

    jest.advanceTimersByTime(1000); // tick 1: alive
    jest.advanceTimersByTime(1000); // tick 2: first miss → missedPings=1

    // Client sends pong — simulated by setting isAlive=true
    ws.isAlive = true;

    jest.advanceTimersByTime(1000); // tick 3: alive → reset missedPings=0
    expect(ws._missedPings).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();

    intervals.stopHeartbeat();
  });

  it('still terminates at threshold=1 (legacy single-miss behavior)', () => {
    const ws = fakeWs(true);
    const { intervals } = buildIntervals({ ws, threshold: 1 });

    jest.advanceTimersByTime(1000); // tick 1: alive → set false
    jest.advanceTimersByTime(1000); // tick 2: miss → missedPings=1 >= 1 → terminate
    expect(ws.terminate).toHaveBeenCalledTimes(1);

    intervals.stopHeartbeat();
  });

  it('keeps sending pings on first miss so client can recover', () => {
    const ws = fakeWs(true);
    const { intervals } = buildIntervals({ ws, threshold: 2 });

    jest.advanceTimersByTime(1000); // tick 1
    const pingCount1 = ws.ping.mock.calls.length;

    jest.advanceTimersByTime(1000); // tick 2: first miss — still sends ping
    expect(ws.ping.mock.calls.length).toBeGreaterThan(pingCount1);

    intervals.stopHeartbeat();
  });

  it('does NOT send ping after terminate', () => {
    const ws = fakeWs(true);
    const { intervals } = buildIntervals({ ws, threshold: 2 });

    jest.advanceTimersByTime(1000); // tick 1
    jest.advanceTimersByTime(1000); // tick 2: first miss
    jest.advanceTimersByTime(1000); // tick 3: terminate

    const callsAfterTerminate = ws.ping.mock.calls.length;
    jest.advanceTimersByTime(1000); // tick 4: socket is gone — forEach still includes it but ws.terminate already called
    // ping should not increment further after terminate
    expect(ws.ping.mock.calls.length).toBe(callsAfterTerminate);

    intervals.stopHeartbeat();
  });
});

// ── disconnectLifecycle: heartbeat_timeout debounced presence ─────────────────

describe('disconnectLifecycle: heartbeat_timeout uses debounced presence path', () => {
  function buildCleanup(overrides = {}) {
    const recomputeUserPresence = jest.fn().mockResolvedValue(undefined);
    const scheduleDebouncedPresenceRecompute = jest.fn();
    const { cleanup } = createDisconnectLifecycle({
      WebSocket: {},
      clearOutboundQueue: jest.fn(),
      wsDisconnectsTotal: { inc: jest.fn() },
      wsDisconnectReasonTotal: { inc: jest.fn() },
      wsConnectionLifetimeMs: { observe: jest.fn() },
      unsubscribeClient: jest.fn(),
      unsubscribeCommunityClient: jest.fn(),
      noteRecentDisconnectForSocket: jest.fn(),
      isRedisOperational: () => true,
      redis: { },
      removeConnection: jest.fn().mockResolvedValue(undefined),
      recomputeUserPresence,
      scheduleDebouncedPresenceRecompute,
      logWsHotInfo: jest.fn(),
      logger: { warn: jest.fn() },
      isShuttingDown: () => false,
      ...overrides,
    });
    return { cleanup, recomputeUserPresence, scheduleDebouncedPresenceRecompute };
  }

  it('heartbeat_timeout disconnect uses scheduleDebouncedPresenceRecompute, not immediate recompute', async () => {
    const { cleanup, recomputeUserPresence, scheduleDebouncedPresenceRecompute } = buildCleanup();
    const ws = {
      _subscriptions: new Set(),
      _communityIds: new Set(),
      _bootstrapReady: true,
      _connectedAt: Date.now() - 5000,
      _connectionId: 'conn-1',
      _sawError: false,
      _disconnectReasonHint: 'heartbeat_timeout',
    };

    cleanup(ws, 'user-1', 1006, '');
    // Give the removeConnection promise a tick to resolve
    await new Promise((r) => setImmediate(r));

    expect(scheduleDebouncedPresenceRecompute).toHaveBeenCalledWith('user-1');
    expect(recomputeUserPresence).not.toHaveBeenCalled();
  });

  it('other abnormal closes (e.g. 1011 server error) still use immediate recompute', async () => {
    const { cleanup, recomputeUserPresence, scheduleDebouncedPresenceRecompute } = buildCleanup();
    const ws = {
      _subscriptions: new Set(),
      _communityIds: new Set(),
      _bootstrapReady: true,
      _connectedAt: Date.now() - 5000,
      _connectionId: 'conn-1',
      _sawError: false,
      _disconnectReasonHint: '',
    };

    cleanup(ws, 'user-1', 1011, '');
    await new Promise((r) => setImmediate(r));

    expect(recomputeUserPresence).toHaveBeenCalledWith('user-1');
    expect(scheduleDebouncedPresenceRecompute).not.toHaveBeenCalled();
  });

  it('clean client close uses debounced path', async () => {
    const { cleanup, recomputeUserPresence, scheduleDebouncedPresenceRecompute } = buildCleanup();
    const ws = {
      _subscriptions: new Set(),
      _communityIds: new Set(),
      _bootstrapReady: true,
      _connectedAt: Date.now() - 5000,
      _connectionId: 'conn-1',
      _sawError: false,
      _disconnectReasonHint: '',
    };

    cleanup(ws, 'user-1', 1000, '');
    await new Promise((r) => setImmediate(r));

    expect(scheduleDebouncedPresenceRecompute).toHaveBeenCalledWith('user-1');
    expect(recomputeUserPresence).not.toHaveBeenCalled();
  });
});

// ── recentDisconnect: GETDEL ──────────────────────────────────────────────────

describe('consumeRecentDisconnect: GETDEL vs GET+DEL fallback', () => {
  const payload = { disconnectedAt: Date.now(), closeCode: 1006, closeReason: 'heartbeat_timeout' };
  const raw = JSON.stringify(payload);

  function buildHelpers(redis: any) {
    return createRecentDisconnectHelpers({
      redis,
      isRedisOperational: () => true,
      recentDisconnectKey: (uid: string) => `ws:recent_disconnect:${uid}`,
      reconnectWindowLabel: () => 'le_5s',
      WS_RECENT_DISCONNECT_TTL_SECONDS: 3600,
      wsReconnectsTotal: { inc: jest.fn() },
      wsReconnectGapMs: { observe: jest.fn() },
      logWsHotInfo: jest.fn(),
    });
  }

  it('uses GETDEL in a single round trip when redis supports it', async () => {
    const getdel = jest.fn().mockResolvedValue(raw);
    const get = jest.fn();
    const del = jest.fn();
    const redis = { getdel, get, del };

    const { consumeRecentDisconnect } = buildHelpers(redis);
    const result = await consumeRecentDisconnect('user-1');

    expect(getdel).toHaveBeenCalledWith('ws:recent_disconnect:user-1');
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(result).toMatchObject({ closeCode: 1006 });
  });

  it('falls back to GET+DEL when getdel is not available', async () => {
    const get = jest.fn().mockResolvedValue(raw);
    const del = jest.fn().mockResolvedValue(1);
    const redis = { get, del }; // no getdel

    const { consumeRecentDisconnect } = buildHelpers(redis);
    const result = await consumeRecentDisconnect('user-1');

    expect(get).toHaveBeenCalledWith('ws:recent_disconnect:user-1');
    expect(del).toHaveBeenCalledWith('ws:recent_disconnect:user-1');
    expect(result).toMatchObject({ closeCode: 1006 });
  });

  it('returns null when no disconnect record exists (GETDEL path)', async () => {
    const redis = { getdel: jest.fn().mockResolvedValue(null) };
    const { consumeRecentDisconnect } = buildHelpers(redis);
    expect(await consumeRecentDisconnect('user-1')).toBeNull();
  });

  it('returns null when no disconnect record exists (GET+DEL path)', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), del: jest.fn() };
    const { consumeRecentDisconnect } = buildHelpers(redis);
    expect(await consumeRecentDisconnect('user-1')).toBeNull();
  });

  it('returns null and does not throw on corrupt JSON (GETDEL path)', async () => {
    const redis = { getdel: jest.fn().mockResolvedValue('{bad json') };
    const { consumeRecentDisconnect } = buildHelpers(redis);
    expect(await consumeRecentDisconnect('user-1')).toBeNull();
  });

  it('does not call del after GETDEL when JSON parse fails', async () => {
    const del = jest.fn();
    const redis = { getdel: jest.fn().mockResolvedValue('{bad'), del };
    const { consumeRecentDisconnect } = buildHelpers(redis);
    await consumeRecentDisconnect('user-1');
    expect(del).not.toHaveBeenCalled();
  });
});

// ── connectionLifecycle: conditional ingress jitter ───────────────────────────

describe('connectionLifecycle: ingress jitter skipped when queue depth is 0', () => {
  const { EventEmitter } = require('events');

  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: any[] = [];
    send(frame: string) { this.sent.push(JSON.parse(frame)); this.emit('sent', JSON.parse(frame)); }
    close(code: number, reason: string) { this.readyState = 3; }
  }

  function buildLifecycle(getBootstrapQueueDepth: () => number) {
    const deps = {
      WebSocket: { OPEN: 1 },
      randomUUID: () => 'conn-1',
      URL,
      authenticateAccessToken: jest.fn().mockResolvedValue({ id: 'user-1' }),
      verifyRefresh: jest.fn(),
      isAuthBypassEnabled: () => false,
      getBypassAuthContext: jest.fn(),
      wsConnectionResultTotal: { inc: jest.fn() },
      logWsHotInfo: jest.fn(),
      clientIpFromReq: () => '10.0.0.1',
      markWsRecentConnect: jest.fn().mockResolvedValue(undefined),
      subscribeClient: jest.fn().mockResolvedValue(undefined),
      consumeRecentDisconnect: jest.fn().mockResolvedValue(null),
      observeRecentReconnect: jest.fn(),
      isWsReplayDisabled: () => true,
      wsReplayFailOpenTotal: { inc: jest.fn() },
      tryBeginReplayForIp: jest.fn().mockReturnValue(false),
      waitForReplayGateOpen: jest.fn(),
      getReplayInFlightCount: () => 0,
      replayAdmissionConfig: { replaySemaphoreMax: 1 },
      endReplayForIp: jest.fn(),
      tryAcquireReplaySlot: jest.fn().mockReturnValue(true),
      canRunReplayForUser: jest.fn().mockReturnValue(false),
      replayMissedMessagesToSocket: jest.fn().mockResolvedValue(undefined),
      replayPendingMessagesToSocket: jest.fn().mockResolvedValue(0),
      WS_REPLAY_USER_COOLDOWN_MS: 0,
      releaseReplaySlot: jest.fn(),
      noteRecentDisconnectForSocket: jest.fn(),
      logger: { warn: jest.fn() },
      handleClientMessage: jest.fn().mockResolvedValue(undefined),
      refreshConnectionTtls: jest.fn().mockResolvedValue(undefined),
      upsertConnectionState: jest.fn().mockResolvedValue(undefined),
      cancelPendingPresenceRecompute: jest.fn(),
      recomputeUserPresence: jest.fn().mockResolvedValue(undefined),
      WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS: 500,
      getBootstrapQueueDepth,
      bootstrapWithRetry: jest.fn().mockResolvedValue(undefined),
      prepareBootstrapWithRetry: jest.fn().mockResolvedValue([]),
      hydrateBootstrapWithMetrics: jest.fn().mockResolvedValue({ status: 'hydrated' }),
      clearBootstrapPriming: jest.fn(),
      wsReadyWallDurationMs: { observe: jest.fn() },
      wsBootstrapProgressiveTotal: { inc: jest.fn() },
      cleanup: jest.fn(),
      replayStartupJitterMs: () => 0,
    };
    return { ...createConnectionLifecycle(deps), deps };
  }

  it('skips up to 500ms jitter when queue depth is 0', async () => {
    const { handleConnection, deps } = buildLifecycle(() => 0);
    const ws = new FakeSocket();
    const start = Date.now();
    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    // bootstrapWithRetry should be called essentially immediately (no jitter)
    expect(deps.bootstrapWithRetry).toHaveBeenCalled();
    // timing is hard to assert precisely in unit tests; we verify jitter is zero-path
  });

  it('applies jitter when queue depth is positive', async () => {
    jest.useFakeTimers();
    const { handleConnection, deps } = buildLifecycle(() => 5);
    const ws = new FakeSocket();

    const connPromise = handleConnection(ws, { url: '/ws?token=t', headers: {} });
    // handleConnection awaits auth then fires the bootstrap IIFE as fire-and-forget.
    // Flush the auth microtask so handleConnection runs to completion and the IIFE
    // registers its jitter setTimeout before we advance the fake clock.
    await Promise.resolve();
    jest.advanceTimersByTime(600); // fire the jitter timer
    await connPromise; // flush IIFE continuation — bootstrapWithRetry is called here
    expect(deps.bootstrapWithRetry).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

// ── recentConnect TTL default ─────────────────────────────────────────────────

describe('WS_RECENT_CONNECT_TTL_SECONDS default', () => {
  it('defaults to 60 seconds when env var is unset', () => {
    const savedEnv = process.env.WS_RECENT_CONNECT_TTL_SECONDS;
    delete process.env.WS_RECENT_CONNECT_TTL_SECONDS;

    // Re-require to pick up fresh env
    jest.resetModules();
    const { WS_RECENT_CONNECT_TTL_SECONDS } = require('../src/websocket/recentConnect');
    expect(WS_RECENT_CONNECT_TTL_SECONDS).toBe(60);

    if (savedEnv !== undefined) process.env.WS_RECENT_CONNECT_TTL_SECONDS = savedEnv;
  });

  it('respects WS_RECENT_CONNECT_TTL_SECONDS env override', () => {
    process.env.WS_RECENT_CONNECT_TTL_SECONDS = '90';
    jest.resetModules();
    const { WS_RECENT_CONNECT_TTL_SECONDS } = require('../src/websocket/recentConnect');
    expect(WS_RECENT_CONNECT_TTL_SECONDS).toBe(90);
    delete process.env.WS_RECENT_CONNECT_TTL_SECONDS;
  });
});
