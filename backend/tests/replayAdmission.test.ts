const {
  parseReplayAdmissionConfig,
  evaluateReplayGate,
  computeReplayDeferredDelayMs,
} = require('../src/websocket/replayAdmission') as {
  parseReplayAdmissionConfig: (env?: Record<string, string | undefined>) => {
    replaySemaphoreMax: number;
    replayDeferMaxAttempts: number;
    replayDeferBaseDelayMs: number;
    replayDeferMaxDelayMs: number;
    replayPoolWaitingThreshold: number;
  };
  evaluateReplayGate: (
    poolWaiting: number,
    inFlight: number,
    config: {
      replaySemaphoreMax: number;
      replayDeferMaxAttempts: number;
      replayDeferBaseDelayMs: number;
      replayDeferMaxDelayMs: number;
      replayPoolWaitingThreshold: number;
    },
  ) => { ok: boolean; reason: 'pool_waiting' | 'semaphore_full' | null };
  computeReplayDeferredDelayMs: (
    attempt: number,
    config: {
      replaySemaphoreMax: number;
      replayDeferMaxAttempts: number;
      replayDeferBaseDelayMs: number;
      replayDeferMaxDelayMs: number;
      replayPoolWaitingThreshold: number;
    },
    random?: () => number,
  ) => number;
};

describe('websocket replay admission', () => {
  it('uses expected defaults when env is missing', () => {
    const cfg = parseReplayAdmissionConfig({});
    expect(cfg).toEqual({
      replaySemaphoreMax: 2,
      replayDeferMaxAttempts: 8,
      replayDeferBaseDelayMs: 250,
      replayDeferMaxDelayMs: 4000,
      replayPoolWaitingThreshold: 0,
    });
  });

  it('clamps and validates env values', () => {
    const cfg = parseReplayAdmissionConfig({
      WS_REPLAY_SEMAPHORE_MAX: '999',
      WS_REPLAY_DEFER_MAX_ATTEMPTS: '-1',
      WS_REPLAY_DEFER_BASE_DELAY_MS: '10',
      WS_REPLAY_DEFER_MAX_DELAY_MS: '20',
      WS_REPLAY_POOL_WAITING_THRESHOLD: '999',
    });

    expect(cfg).toEqual({
      replaySemaphoreMax: 32,
      replayDeferMaxAttempts: 8,
      replayDeferBaseDelayMs: 250,
      replayDeferMaxDelayMs: 4000,
      replayPoolWaitingThreshold: 128,
    });
  });

  it('defers on pool waiting above threshold before checking semaphore', () => {
    const cfg = parseReplayAdmissionConfig({
      WS_REPLAY_POOL_WAITING_THRESHOLD: '1',
      WS_REPLAY_SEMAPHORE_MAX: '2',
    });

    expect(evaluateReplayGate(2, 0, cfg)).toEqual({ ok: false, reason: 'pool_waiting' });
    expect(evaluateReplayGate(2, 99, cfg)).toEqual({ ok: false, reason: 'pool_waiting' });
  });

  it('allows replay at threshold and blocks when semaphore is full', () => {
    const cfg = parseReplayAdmissionConfig({
      WS_REPLAY_POOL_WAITING_THRESHOLD: '1',
      WS_REPLAY_SEMAPHORE_MAX: '2',
    });

    expect(evaluateReplayGate(1, 1, cfg)).toEqual({ ok: true, reason: null });
    expect(evaluateReplayGate(1, 2, cfg)).toEqual({ ok: false, reason: 'semaphore_full' });
  });

  it('computes bounded exponential delays with jitter', () => {
    const cfg = parseReplayAdmissionConfig({
      WS_REPLAY_DEFER_BASE_DELAY_MS: '250',
      WS_REPLAY_DEFER_MAX_DELAY_MS: '4000',
    });

    expect(computeReplayDeferredDelayMs(1, cfg, () => 0)).toBe(250);
    expect(computeReplayDeferredDelayMs(2, cfg, () => 0)).toBe(500);
    expect(computeReplayDeferredDelayMs(3, cfg, () => 0)).toBe(1000);
    expect(computeReplayDeferredDelayMs(4, cfg, () => 0)).toBe(2000);
    expect(computeReplayDeferredDelayMs(5, cfg, () => 0)).toBe(4000);
    expect(computeReplayDeferredDelayMs(8, cfg, () => 0)).toBe(4000);
    expect(computeReplayDeferredDelayMs(8, cfg, () => 0.9999)).toBe(4149);
  });
});

