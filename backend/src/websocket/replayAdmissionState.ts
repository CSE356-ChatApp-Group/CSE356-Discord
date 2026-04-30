const {
  parseReplayAdmissionConfig,
  evaluateReplayGate,
  computeReplayDeferredDelayMs,
} = require("./replayAdmission");

function createReplayAdmissionState({
  env,
  poolStats,
  wsReplayConcurrentGauge,
  wsReplaySemaphoreCapGauge,
  logWsHotInfo,
  replayUserCooldownMs,
  isReplayIpExemptFromPerIpCap,
  isSocketOpen,
}) {
  const replayAdmissionConfig = parseReplayAdmissionConfig(env);
  wsReplaySemaphoreCapGauge.set(replayAdmissionConfig.replaySemaphoreMax);

  let wsReplayInFlightCount = 0;
  wsReplayConcurrentGauge.set(0);
  const recentReplayByUser = new Map();
  const replayIpConcurrency = new Map();

  function getReplayInFlightCount() {
    return wsReplayInFlightCount;
  }

  function tryAcquireReplaySlot() {
    if (wsReplayInFlightCount >= replayAdmissionConfig.replaySemaphoreMax) return false;
    wsReplayInFlightCount += 1;
    wsReplayConcurrentGauge.set(wsReplayInFlightCount);
    return true;
  }

  function releaseReplaySlot() {
    wsReplayInFlightCount = Math.max(0, wsReplayInFlightCount - 1);
    wsReplayConcurrentGauge.set(wsReplayInFlightCount);
  }

  function canRunReplayForUser(userId) {
    const now = Date.now();
    const last = recentReplayByUser.get(userId) || 0;
    if (now - last < replayUserCooldownMs) {
      return false;
    }
    recentReplayByUser.set(userId, now);
    return true;
  }

  function tryBeginReplayForIp(ip) {
    if (isReplayIpExemptFromPerIpCap(ip)) return true;
    const key = ip || "unknown";
    const n = replayIpConcurrency.get(key) || 0;
    if (n >= 1) return false;
    replayIpConcurrency.set(key, n + 1);
    return true;
  }

  function endReplayForIp(ip) {
    if (isReplayIpExemptFromPerIpCap(ip)) return;
    const key = ip || "unknown";
    const n = (replayIpConcurrency.get(key) || 0) - 1;
    if (n <= 0) replayIpConcurrency.delete(key);
    else replayIpConcurrency.set(key, n);
  }

  function replayGateSnapshot() {
    const pool = poolStats();
    const gate = evaluateReplayGate(
      Number(pool.waiting || 0),
      wsReplayInFlightCount,
      replayAdmissionConfig,
    );
    return { ...gate, pool };
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForReplayGateOpen(ws, userId) {
    let attempts = 0;
    let totalWaitMs = 0;
    let lastGate = replayGateSnapshot();
    while (!lastGate.ok && attempts < replayAdmissionConfig.replayDeferMaxAttempts) {
      attempts += 1;
      if (!isSocketOpen(ws)) {
        return { ok: false, gate: lastGate, attempts, totalWaitMs, cancelled: true };
      }
      const delayMs = computeReplayDeferredDelayMs(attempts, replayAdmissionConfig);
      totalWaitMs += delayMs;
      await sleepMs(delayMs);
      lastGate = replayGateSnapshot();
    }
    if (attempts > 0 && lastGate.ok) {
      logWsHotInfo(() => ({
          userId,
          attempts,
          totalWaitMs,
        }),
        "WS reconnect replay admission deferred before success");
    }
    return { ok: lastGate.ok, gate: lastGate, attempts, totalWaitMs, cancelled: false };
  }

  return {
    replayAdmissionConfig,
    getReplayInFlightCount,
    tryAcquireReplaySlot,
    releaseReplaySlot,
    canRunReplayForUser,
    tryBeginReplayForIp,
    endReplayForIp,
    waitForReplayGateOpen,
  };
}

module.exports = {
  createReplayAdmissionState,
};
