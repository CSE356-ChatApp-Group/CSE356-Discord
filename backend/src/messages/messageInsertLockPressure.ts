/**
 * In-process rolling window of channel insert lock wait samples and timeouts.
 * Drives conservative PUT /messages/:id/read shedding when POST /messages lock
 * pressure is high (same worker view).
 */


const {
  messageChannelInsertLockPressureWaitP95MsGauge,
  messageChannelInsertLockPressureRecentTimeoutsGauge,
} = require('../utils/metrics');

type AcquireSample = { t: number; waitMs: number };

const acquireSamples: AcquireSample[] = [];
const timeoutTimestamps: number[] = [];
let readShedActiveUntilMs = 0;

const MAX_SAMPLES = 512;
const MAX_TIMEOUT_MARKERS = 128;

function parseWindowMs(): number {
  const v = Number.parseInt(
    process.env.MESSAGE_INSERT_LOCK_PRESSURE_WINDOW_MS || '',
    10,
  );
  if (!Number.isFinite(v)) return 30000;
  return Math.min(120000, Math.max(5000, v));
}

/** p95 wait threshold (ms); default 320, clamped to 200–500. */
function parseP95ThresholdMs(): number {
  const v = Number.parseInt(
    process.env.READ_SHED_MESSAGE_INSERT_LOCK_WAIT_P95_MS || '',
    10,
  );
  if (!Number.isFinite(v)) return 320;
  return Math.min(500, Math.max(200, v));
}

function parseMinSamplesForP95(): number {
  const v = Number.parseInt(
    process.env.READ_SHED_MESSAGE_INSERT_LOCK_MIN_SAMPLES_FOR_P95 || '',
    10,
  );
  if (!Number.isFinite(v)) return 6;
  return Math.min(100, Math.max(1, v));
}

/** Keep read-shed active briefly after trigger to avoid threshold flapping. */
function parseReadShedCooldownMs(): number {
  const v = Number.parseInt(
    process.env.READ_SHED_MESSAGE_INSERT_LOCK_COOLDOWN_MS || '',
    10,
  );
  if (!Number.isFinite(v)) return 3000;
  return Math.min(15000, Math.max(500, v));
}

/** Optional lower p95 bound used to clear active cool-down early when healthy. */
function parseReadShedRecoverP95Ms(triggerP95: number): number {
  const v = Number.parseInt(
    process.env.READ_SHED_MESSAGE_INSERT_LOCK_RECOVER_P95_MS || '',
    10,
  );
  if (!Number.isFinite(v)) return Math.max(120, triggerP95 - 80);
  return Math.min(triggerP95, Math.max(80, v));
}

function prune(nowMs: number) {
  const cutoff = nowMs - parseWindowMs();
  let i = 0;
  while (i < acquireSamples.length && acquireSamples[i].t < cutoff) i += 1;
  if (i > 0) acquireSamples.splice(0, i);
  let j = 0;
  while (j < timeoutTimestamps.length && timeoutTimestamps[j] < cutoff) j += 1;
  if (j > 0) timeoutTimestamps.splice(0, j);
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function recordMessageChannelInsertLockAcquireWait(waitMs: number) {
  const t = Date.now();
  prune(t);
  acquireSamples.push({ t, waitMs: Math.max(0, waitMs) });
  if (acquireSamples.length > MAX_SAMPLES) {
    acquireSamples.splice(0, acquireSamples.length - MAX_SAMPLES);
  }
}

function recordMessageChannelInsertLockTimeoutEvent() {
  const t = Date.now();
  prune(t);
  timeoutTimestamps.push(t);
  if (timeoutTimestamps.length > MAX_TIMEOUT_MARKERS) {
    timeoutTimestamps.splice(
      0,
      timeoutTimestamps.length - MAX_TIMEOUT_MARKERS,
    );
  }
}

/**
 * Updates lock-pressure snapshot gauges and returns whether PUT /read should
 * soft-defer (200 + deferred, no cursor / fanout / enqueue).
 */
function getShouldDeferReadReceiptForInsertLockPressure(): boolean {
  const t = Date.now();
  prune(t);
  const waits = acquireSamples.map((s) => s.waitMs);
  const p95 = percentile95(waits);
  const recentTimeoutCount = timeoutTimestamps.length;
  const triggerP95 = parseP95ThresholdMs();
  const clearP95 = parseReadShedRecoverP95Ms(triggerP95);
  const minS = parseMinSamplesForP95();
  const cooldownMs = parseReadShedCooldownMs();
  messageChannelInsertLockPressureWaitP95MsGauge?.set?.(p95);
  messageChannelInsertLockPressureRecentTimeoutsGauge?.set?.(recentTimeoutCount);

  const hasTimeoutPressure = recentTimeoutCount >= 1;
  const hasP95Pressure = waits.length >= minS && p95 > triggerP95;
  // Any sustained tail wait in-window implies contention even before p95 crosses.
  const hasTailPressure = waits.length >= 4 && waits.some((w) => w >= 380);
  const shouldTrigger = hasTimeoutPressure || hasP95Pressure || hasTailPressure;
  if (shouldTrigger) {
    readShedActiveUntilMs = Math.max(readShedActiveUntilMs, t + cooldownMs);
    return true;
  }

  if (t < readShedActiveUntilMs) {
    // Allow early clear only when the window has enough healthy samples.
    const hasHealthyWindow =
      waits.length >= Math.max(4, minS) &&
      recentTimeoutCount === 0 &&
      p95 <= clearP95 &&
      !waits.some((w) => w >= 340);
    if (hasHealthyWindow) {
      readShedActiveUntilMs = 0;
      return false;
    }
    return true;
  }
  return false;
}

function resetMessageChannelInsertLockPressureForTests() {
  acquireSamples.length = 0;
  timeoutTimestamps.length = 0;
  readShedActiveUntilMs = 0;
}

/** Alias: same signal used to shed read receipts, WS replay, search, etc. */
function isMessageChannelInsertLockPressureHigh() {
  return getShouldDeferReadReceiptForInsertLockPressure();
}

module.exports = {
  recordMessageChannelInsertLockAcquireWait,
  recordMessageChannelInsertLockTimeoutEvent,
  getShouldDeferReadReceiptForInsertLockPressure,
  isMessageChannelInsertLockPressureHigh,
  resetMessageChannelInsertLockPressureForTests,
};
