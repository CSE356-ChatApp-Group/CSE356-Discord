/**
 * Short-lived process-local WS pressure gate.
 *
 * This protects primary message delivery by letting lower-priority read-receipt
 * fanout degrade when the same worker observes realtime delivery/bootstrap
 * pressure. Durable read state must continue to advance while this gate is on.
 */

type WsPressureReason =
  | 'realtime_latency'
  | 'bootstrap_wall'
  | 'realtime_miss';

const MISS_WINDOW_MS = 10_000;
const MAX_MISS_TIMESTAMPS = 256;

const pressureMissReasons = new Set([
  'topic_message_partial_delivery',
  'topic_message_send_blocked',
  'channel_topic_stale_map_userfeed_recovery',
]);

let pressureUntilMs = 0;
let lastReason: WsPressureReason | null = null;
const missTimestamps: number[] = [];

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function enabled(): boolean {
  return parseBoolEnv('READ_RECEIPT_DROP_FANOUT_ON_WS_PRESSURE_ENABLED', true);
}

function ttlMs(): number {
  const min = process.env.NODE_ENV === 'test' ? 1 : 5_000;
  return parseIntEnv('READ_RECEIPT_WS_PRESSURE_TTL_MS', 30_000, min, 300_000);
}

function realtimeLatencyThresholdMs(): number {
  return parseIntEnv('READ_RECEIPT_WS_PRESSURE_REALTIME_LATENCY_MS', 5_000, 1_000, 300_000);
}

function bootstrapWallThresholdMs(): number {
  return parseIntEnv('READ_RECEIPT_WS_PRESSURE_BOOTSTRAP_WALL_MS', 10_000, 1_000, 300_000);
}

function missThreshold(): number {
  return parseIntEnv('READ_RECEIPT_WS_PRESSURE_MISS_COUNT', 20, 1, 10_000);
}

function activate(reason: WsPressureReason, nowMs = Date.now()): void {
  if (!enabled()) return;
  pressureUntilMs = Math.max(pressureUntilMs, nowMs + ttlMs());
  lastReason = reason;
}

function pruneMissTimestamps(nowMs: number): void {
  const cutoff = nowMs - MISS_WINDOW_MS;
  let i = 0;
  while (i < missTimestamps.length && missTimestamps[i] < cutoff) i += 1;
  if (i > 0) missTimestamps.splice(0, i);
  if (missTimestamps.length > MAX_MISS_TIMESTAMPS) {
    missTimestamps.splice(0, missTimestamps.length - MAX_MISS_TIMESTAMPS);
  }
}

function recordWsReliableRealtimeLatencyMs(deltaMs: number): void {
  if (!enabled()) return;
  if (!Number.isFinite(deltaMs) || deltaMs < realtimeLatencyThresholdMs()) return;
  activate('realtime_latency');
}

function recordWsBootstrapWallMs(deltaMs: number): void {
  if (!enabled()) return;
  if (!Number.isFinite(deltaMs) || deltaMs < bootstrapWallThresholdMs()) return;
  activate('bootstrap_wall');
}

function recordRealtimeMissAttribution(reason: string, count = 1): void {
  if (!enabled()) return;
  if (!pressureMissReasons.has(reason)) return;
  const nowMs = Date.now();
  pruneMissTimestamps(nowMs);
  const n = Math.max(1, Math.min(1000, Math.floor(Number(count) || 1)));
  for (let i = 0; i < n; i += 1) missTimestamps.push(nowMs);
  pruneMissTimestamps(nowMs);
  if (missTimestamps.length >= missThreshold()) {
    activate('realtime_miss', nowMs);
  }
}

function shouldDropReadReceiptFanoutForWsPressure(nowMs = Date.now()): boolean {
  if (!enabled()) return false;
  return nowMs < pressureUntilMs;
}

function getWsDeliveryPressureSnapshot(nowMs = Date.now()) {
  return {
    active: shouldDropReadReceiptFanoutForWsPressure(nowMs),
    untilMs: pressureUntilMs,
    lastReason,
    missWindowCount: (() => {
      pruneMissTimestamps(nowMs);
      return missTimestamps.length;
    })(),
  };
}

function resetWsDeliveryPressureForTests(): void {
  pressureUntilMs = 0;
  lastReason = null;
  missTimestamps.length = 0;
}

module.exports = {
  recordWsReliableRealtimeLatencyMs,
  recordWsBootstrapWallMs,
  recordRealtimeMissAttribution,
  shouldDropReadReceiptFanoutForWsPressure,
  getWsDeliveryPressureSnapshot,
  resetWsDeliveryPressureForTests,
};
