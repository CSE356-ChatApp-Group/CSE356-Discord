const { EventEmitter } = require('events');
const { createConnectionLifecycle } = require('../src/websocket/connectionLifecycle');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(frame) {
    const parsed = JSON.parse(frame);
    this.sent.push(parsed);
    this.emit('sent', parsed);
  }

  close(code, reason) {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForFrame(ws, predicate) {
  const found = ws.sent.find(predicate);
  if (found) return found;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('sent', onSent);
      reject(new Error('Timed out waiting for websocket frame'));
    }, 500);
    const onSent = (frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      ws.off('sent', onSent);
      resolve(frame);
    };
    ws.on('sent', onSent);
  });
}

async function waitUntil(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('Timed out waiting for condition');
}

function buildHarness(overrides = {}) {
  const wsConnectionResultTotal = { inc: jest.fn() };
  const wsReplayFailOpenTotal = { inc: jest.fn() };
  const logger = { warn: jest.fn() };
  const wsReadyWallDurationMs = { observe: jest.fn() };
  const wsBootstrapProgressiveTotal = { inc: jest.fn() };
  const deps = {
    WebSocket: { OPEN: 1 },
    randomUUID: () => 'conn-1',
    URL,
    authenticateAccessToken: jest.fn().mockResolvedValue({ id: 'user-1' }),
    verifyRefresh: jest.fn(),
    isAuthBypassEnabled: () => false,
    getBypassAuthContext: jest.fn(),
    wsConnectionResultTotal,
    logWsHotInfo: jest.fn(),
    clientIpFromReq: () => '198.51.100.1',
    markWsRecentConnect: jest.fn().mockResolvedValue(undefined),
    subscribeClient: jest.fn().mockResolvedValue(undefined),
    consumeRecentDisconnect: jest.fn().mockResolvedValue(null),
    observeRecentReconnect: jest.fn(),
    isWsReplayDisabled: () => false,
    wsReplayFailOpenTotal,
    tryBeginReplayForIp: jest.fn().mockReturnValue(true),
    waitForReplayGateOpen: jest.fn().mockResolvedValue({
      ok: true,
      cancelled: false,
      gate: { reason: null, pool: { waiting: 0 } },
      attempts: 0,
      totalWaitMs: 0,
    }),
    getReplayInFlightCount: () => 0,
    replayAdmissionConfig: { replaySemaphoreMax: 1 },
    endReplayForIp: jest.fn(),
    tryAcquireReplaySlot: jest.fn().mockReturnValue(true),
    canRunReplayForUser: jest.fn().mockReturnValue(true),
    replayMissedMessagesToSocket: jest.fn().mockResolvedValue(undefined),
    replayPendingMessagesToSocket: jest.fn().mockResolvedValue(0),
    WS_REPLAY_USER_COOLDOWN_MS: 0,
    releaseReplaySlot: jest.fn(),
    noteRecentDisconnectForSocket: jest.fn(),
    logger,
    handleClientMessage: jest.fn().mockResolvedValue(undefined),
    refreshConnectionTtls: jest.fn().mockResolvedValue(undefined),
    upsertConnectionState: jest.fn().mockResolvedValue(undefined),
    cancelPendingPresenceRecompute: jest.fn(),
    recomputeUserPresence: jest.fn().mockResolvedValue(undefined),
    WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS: 0,
    bootstrapWithRetry: jest.fn().mockResolvedValue(undefined),
    prepareBootstrapWithRetry: jest.fn().mockResolvedValue(['channel:one', 'conversation:two', 'community:three']),
    hydrateBootstrapWithMetrics: jest.fn().mockResolvedValue(undefined),
    wsReadyWallDurationMs,
    wsBootstrapProgressiveTotal,
    cleanup: jest.fn(),
    replayStartupJitterMs: () => 0,
    ...overrides,
  };
  return {
    deps,
    handleConnection: createConnectionLifecycle(deps).handleConnection,
    wsConnectionResultTotal,
    wsReplayFailOpenTotal,
    logger,
    wsReadyWallDurationMs,
    wsBootstrapProgressiveTotal,
  };
}

describe('progressive websocket bootstrap ready', () => {
  const prevProgressive = process.env.WS_BOOTSTRAP_PROGRESSIVE_READY;
  const prevSkipDbWhenPendingHit = process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT;

  afterEach(() => {
    if (prevProgressive === undefined) delete process.env.WS_BOOTSTRAP_PROGRESSIVE_READY;
    else process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = prevProgressive;
    if (prevSkipDbWhenPendingHit === undefined) delete process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT;
    else process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT = prevSkipDbWhenPendingHit;
  });

  it('keeps strict ready behavior when the flag is off', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'false';
    const strictBootstrap = deferred();
    const { handleConnection, deps, wsReadyWallDurationMs } = buildHarness({
      bootstrapWithRetry: jest.fn().mockReturnValue(strictBootstrap.promise),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    await flush();
    expect(ws.sent.some((frame) => frame.event === 'ready')).toBe(false);
    expect(deps.prepareBootstrapWithRetry).not.toHaveBeenCalled();

    strictBootstrap.resolve();
    const ready = await waitForFrame(ws, (frame) => frame.event === 'ready');
    expect(ready.data).toEqual(expect.objectContaining({
      bootstrapComplete: true,
      subscriptionsHydrated: true,
      progressiveHydration: false,
    }));
    expect(wsReadyWallDurationMs.observe).toHaveBeenCalledWith({ mode: 'strict' }, expect.any(Number));
  });

  it('sends honest early ready and emits bootstrap:complete after background hydration', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    const hydration = deferred();
    const { handleConnection, deps, wsBootstrapProgressiveTotal, wsReadyWallDurationMs } = buildHarness({
      hydrateBootstrapWithMetrics: jest.fn().mockReturnValue(hydration.promise),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    const ready = await waitForFrame(ws, (frame) => frame.event === 'ready');
    expect(ready.data).toEqual(expect.objectContaining({
      bootstrapComplete: false,
      subscriptionsHydrated: false,
      progressiveHydration: true,
    }));
    expect(deps.subscribeClient).toHaveBeenCalledWith(ws, 'user:user-1');
    expect(deps.prepareBootstrapWithRetry).toHaveBeenCalledWith(ws, 'user-1');
    expect(deps.hydrateBootstrapWithMetrics).toHaveBeenCalledWith(
      ws,
      'user-1',
      ['channel:one', 'conversation:two', 'community:three'],
    );
    expect(ws.sent.some((frame) => frame.type === 'bootstrap:complete')).toBe(false);
    expect(wsBootstrapProgressiveTotal.inc).toHaveBeenCalledWith({ result: 'ready_sent' });
    expect(wsReadyWallDurationMs.observe).toHaveBeenCalledWith({ mode: 'progressive' }, expect.any(Number));

    hydration.resolve();
    const complete = await waitForFrame(ws, (frame) => frame.type === 'bootstrap:complete');
    expect(complete.data).toEqual(expect.objectContaining({
      bootstrapComplete: true,
      subscriptionsHydrated: true,
      progressiveHydration: true,
    }));
    expect(ws._subscriptionsHydrated).toBe(true);
    expect(wsBootstrapProgressiveTotal.inc).toHaveBeenCalledWith({ result: 'hydration_complete' });
  });

  it('does not wait for bootstrap preparation before sending progressive ready', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    const preparedChannels = deferred();
    const hydration = deferred();
    const { handleConnection, deps, wsBootstrapProgressiveTotal } = buildHarness({
      prepareBootstrapWithRetry: jest.fn().mockReturnValue(preparedChannels.promise),
      hydrateBootstrapWithMetrics: jest.fn().mockReturnValue(hydration.promise),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    const ready = await waitForFrame(ws, (frame) => frame.event === 'ready');
    expect(ready.data).toEqual(expect.objectContaining({
      bootstrapComplete: false,
      subscriptionsHydrated: false,
      progressiveHydration: true,
    }));
    expect(deps.hydrateBootstrapWithMetrics).not.toHaveBeenCalled();

    preparedChannels.resolve(['channel:one']);
    await flush();
    expect(deps.hydrateBootstrapWithMetrics).toHaveBeenCalledWith(ws, 'user-1', ['channel:one']);

    hydration.resolve();
    await waitForFrame(ws, (frame) => frame.type === 'bootstrap:complete');
    expect(wsBootstrapProgressiveTotal.inc).toHaveBeenCalledWith({ result: 'ready_sent' });
    expect(wsBootstrapProgressiveTotal.inc).toHaveBeenCalledWith({ result: 'hydration_complete' });
  });

  it('logs and counts progressive background hydration failures', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    const { handleConnection, logger, wsBootstrapProgressiveTotal } = buildHarness({
      hydrateBootstrapWithMetrics: jest.fn().mockRejectedValue(new Error('hydrate exploded')),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    await waitForFrame(ws, (frame) => frame.event === 'ready');
    await flush();

    expect(ws.sent.some((frame) => frame.type === 'bootstrap:complete')).toBe(false);
    expect(wsBootstrapProgressiveTotal.inc).toHaveBeenCalledWith({ result: 'hydration_failed' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: 'user-1' }),
      'WS progressive bootstrap hydration failed',
    );
  });

  it('sends progressive ready before reconnect replay and pending drain finish', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    const replay = deferred();
    const pending = deferred();
    const { handleConnection } = buildHarness({
      consumeRecentDisconnect: jest.fn().mockResolvedValue({ disconnectedAt: Date.now() - 1000 }),
      replayMissedMessagesToSocket: jest.fn().mockReturnValue(replay.promise),
      replayPendingMessagesToSocket: jest.fn().mockReturnValue(pending.promise),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    await flush();
    pending.resolve(0);
    const ready = await waitForFrame(ws, (frame) => frame.event === 'ready');
    expect(ready.data.progressiveHydration).toBe(true);
    expect(ws.sent.some((frame) => frame.event === 'ready')).toBe(true);

    replay.resolve();
    await flush();
  });

  it('skips acquiring a replay slot when pending replay already satisfied reconnect delivery', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT = 'true';
    const replayMissedMessagesToSocket = jest.fn().mockResolvedValue(undefined);
    const tryAcquireReplaySlot = jest.fn().mockReturnValue(true);
    const replayPendingMessagesToSocket = jest.fn().mockResolvedValue(3);
    const { handleConnection, deps } = buildHarness({
      consumeRecentDisconnect: jest.fn().mockResolvedValue({ disconnectedAt: Date.now() - 1000 }),
      replayMissedMessagesToSocket,
      replayPendingMessagesToSocket,
      tryAcquireReplaySlot,
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    await waitForFrame(ws, (frame) => frame.event === 'ready');
    await waitUntil(() => replayPendingMessagesToSocket.mock.calls.length > 0);

    expect(replayPendingMessagesToSocket).toHaveBeenCalledWith(ws, 'user-1');
    expect(replayMissedMessagesToSocket).not.toHaveBeenCalled();
    expect(tryAcquireReplaySlot).not.toHaveBeenCalled();
    expect(deps.releaseReplaySlot).not.toHaveBeenCalled();
  });

  it('releases the replay slot before waiting on pending drain', async () => {
    process.env.WS_BOOTSTRAP_PROGRESSIVE_READY = 'true';
    delete process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT;
    const pending = deferred();
    const replayMissedMessagesToSocket = jest.fn().mockResolvedValue(undefined);
    const { handleConnection, deps } = buildHarness({
      consumeRecentDisconnect: jest.fn().mockResolvedValue({ disconnectedAt: Date.now() - 1000 }),
      replayMissedMessagesToSocket,
      replayPendingMessagesToSocket: jest.fn().mockReturnValue(pending.promise),
    });
    const ws = new FakeSocket();

    await handleConnection(ws, { url: '/ws?token=t', headers: {} });
    await waitForFrame(ws, (frame) => frame.event === 'ready');
    await waitUntil(() => deps.releaseReplaySlot.mock.calls.length > 0);

    expect(replayMissedMessagesToSocket).toHaveBeenCalled();
    expect(deps.releaseReplaySlot).toHaveBeenCalledTimes(1);

    pending.resolve(0);
    await flush();
  });
});
