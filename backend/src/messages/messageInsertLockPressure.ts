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
  messageChannelInsertLockPressureWaitP95MsGauge?.set?.(p95);
  messageChannelInsertLockPressureRecentTimeoutsGauge?.set?.(recentTimeoutCount);

  if (recentTimeoutCount >= 1) return true;
  const minS = parseMinSamplesForP95();
  if (waits.length >= minS && p95 > parseP95ThresholdMs()) return true;
  // Any sustained tail wait in-window implies contention even before p95 crosses.
  if (waits.length >= 4 && waits.some((w) => w >= 380)) return true;
  return false;
}

function resetMessageChannelInsertLockPressureForTests() {
  acquireSamples.length = 0;
  timeoutTimestamps.length = 0;
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
