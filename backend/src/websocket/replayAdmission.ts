'use strict';

type ReplayGateReason = 'pool_waiting' | 'semaphore_full';

type ReplayAdmissionConfig = {
  replaySemaphoreMax: number;
  replayDeferMaxAttempts: number;
  replayDeferBaseDelayMs: number;
  replayDeferMaxDelayMs: number;
  replayPoolWaitingThreshold: number;
};

function parseReplayAdmissionConfig(env: NodeJS.ProcessEnv = process.env): ReplayAdmissionConfig {
  const rawWsReplaySemaphoreMax = Number(env.WS_REPLAY_SEMAPHORE_MAX || '2');
  const replaySemaphoreMax =
    Number.isFinite(rawWsReplaySemaphoreMax) && rawWsReplaySemaphoreMax > 0
      ? Math.min(32, Math.floor(rawWsReplaySemaphoreMax))
      : 2;

  const rawWsReplayDeferredMaxAttempts = Number(env.WS_REPLAY_DEFER_MAX_ATTEMPTS || '8');
  const replayDeferMaxAttempts =
    Number.isFinite(rawWsReplayDeferredMaxAttempts) && rawWsReplayDeferredMaxAttempts > 0
      ? Math.min(20, Math.floor(rawWsReplayDeferredMaxAttempts))
      : 8;

  const rawWsReplayDeferredBaseDelayMs = Number(env.WS_REPLAY_DEFER_BASE_DELAY_MS || '250');
  const replayDeferBaseDelayMs =
    Number.isFinite(rawWsReplayDeferredBaseDelayMs) && rawWsReplayDeferredBaseDelayMs >= 50
      ? Math.min(5_000, Math.floor(rawWsReplayDeferredBaseDelayMs))
      : 250;

  const rawWsReplayDeferredMaxDelayMs = Number(env.WS_REPLAY_DEFER_MAX_DELAY_MS || '4000');
  const replayDeferMaxDelayMs =
    Number.isFinite(rawWsReplayDeferredMaxDelayMs)
    && rawWsReplayDeferredMaxDelayMs >= replayDeferBaseDelayMs
      ? Math.min(30_000, Math.floor(rawWsReplayDeferredMaxDelayMs))
      : 4_000;

  const rawWsReplayPoolWaitingThreshold = Number(env.WS_REPLAY_POOL_WAITING_THRESHOLD || '0');
  const replayPoolWaitingThreshold =
    Number.isFinite(rawWsReplayPoolWaitingThreshold) && rawWsReplayPoolWaitingThreshold >= 0
      ? Math.min(128, Math.floor(rawWsReplayPoolWaitingThreshold))
      : 0;

  return {
    replaySemaphoreMax,
    replayDeferMaxAttempts,
    replayDeferBaseDelayMs,
    replayDeferMaxDelayMs,
    replayPoolWaitingThreshold,
  };
}

function evaluateReplayGate(
  poolWaiting: number,
  inFlight: number,
  config: ReplayAdmissionConfig,
): { ok: true; reason: null } | { ok: false; reason: ReplayGateReason } {
  if (poolWaiting > config.replayPoolWaitingThreshold) {
    return { ok: false, reason: 'pool_waiting' };
  }
  if (inFlight >= config.replaySemaphoreMax) {
    return { ok: false, reason: 'semaphore_full' };
  }
  return { ok: true, reason: null };
}

function computeReplayDeferredDelayMs(
  attempt: number,
  config: ReplayAdmissionConfig,
  random: () => number = Math.random,
) {
  const n = Number(attempt || 1);
  const power = Math.max(0, Math.min(10, n - 1));
  const exp = config.replayDeferBaseDelayMs * (2 ** power);
  const bounded = Math.min(config.replayDeferMaxDelayMs, exp);
  const jitter = Math.floor(random() * 150);
  return bounded + jitter;
}

module.exports = {
  parseReplayAdmissionConfig,
  evaluateReplayGate,
  computeReplayDeferredDelayMs,
};

