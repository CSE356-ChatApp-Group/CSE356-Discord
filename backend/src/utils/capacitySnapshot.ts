
/**
 * Periodic structured log + /health?diagnostic=1 payload builder.
 *
 * Schema is intentionally flat under `capacity` where possible so pasted JSON
 * is easy for humans and tools to reason about (bottleneck = pool waiting,
 * overload_stage>0, high event_loop_lag_p99_ms, redis_ping_ms null, etc.).
 *
 * Env:
 *   CAPACITY_SNAPSHOT_INTERVAL_MS — default 60000 in production, 0 elsewhere (off).
 *                                   Set to 0 to disable; positive to override interval.
 */

const logger = require('./logger');
const overload = require('./overload');
const { poolStats } = require('../db/pool');
const redis = require('../db/redis');
const wsServer = require('../websocket/server');
const { getBcryptQueueStats } = require('../auth/passwords');
const { getQueueStats } = require('../messages/sideEffects');

function parseEnvInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function pgPoolConfig() {
  return {
    max: parseEnvInt('PG_POOL_MAX', 25),
    circuit_queue_max: parseEnvInt('POOL_CIRCUIT_BREAKER_QUEUE', 32),
  };
}

async function measureRedisPingMs(): Promise<number | null> {
  const t0 = Date.now();
  try {
    await redis.ping();
    return Date.now() - t0;
  } catch {
    return null;
  }
}

function buildCapacityCore(
  loadSnapshot: ReturnType<typeof overload.getLoadSnapshot>,
  pool: ReturnType<typeof poolStats>,
  redisPingMs: number | null,
) {
  const cfg = pgPoolConfig();
  const bcrypt = getBcryptQueueStats();
  const sideEffects = getQueueStats();
  return {
    schema: 1,
    port: parseEnvInt('PORT', 0),
    pid: process.pid,
    uptime_sec: Math.round(process.uptime()),
    overload_stage: loadSnapshot.overload_stage,
    rss_mb: loadSnapshot.rss_mb,
    heap_used_mb: loadSnapshot.heap_used_mb,
    event_loop_lag_p99_ms: loadSnapshot.event_loop_lag_p99_ms,
    pg_pool_total: pool.total,
    pg_pool_idle: pool.idle,
    pg_pool_waiting: pool.waiting,
    pg_pool_max: pool.max,
    pg_pool_circuit_queue_max: cfg.circuit_queue_max,
    ws_local_clients: wsServer.getLocalWebSocketClientCount(),
    bcrypt_active: bcrypt.active,
    bcrypt_waiting: bcrypt.waiting,
    bcrypt_max_concurrent: bcrypt.max_concurrent,
    bcrypt_max_waiters: bcrypt.max_waiters,
    fanout_critical_depth: sideEffects.critical.depth,
    fanout_critical_workers: sideEffects.critical.active_workers,
    fanout_critical_max_depth: sideEffects.critical.max_depth,
    fanout_background_depth: sideEffects.background.depth,
    fanout_background_workers: sideEffects.background.active_workers,
    fanout_background_max_depth: sideEffects.background.max_depth,
    redis_ping_ms: redisPingMs,
  };
}

async function buildCapacityPayload() {
  const load = overload.getLoadSnapshot();
  const pool = poolStats();
  const redisPingMs = await measureRedisPingMs();
  return buildCapacityCore(load, pool, redisPingMs);
}

async function logCapacitySnapshot() {
  try {
    const capacity = await buildCapacityPayload();
    logger.info({ kind: 'capacity_snapshot', capacity }, 'capacity_snapshot');
  } catch (err: any) {
    logger.warn({ err }, 'capacity_snapshot failed');
  }
}

function snapshotIntervalMs(): number {
  const raw = process.env.CAPACITY_SNAPSHOT_INTERVAL_MS;
  if (raw === '0') return 0;
  if (raw != null && raw !== '') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return process.env.NODE_ENV === 'production' ? 60_000 : 0;
}

function startCapacitySnapshotHeartbeat() {
  const ms = snapshotIntervalMs();
  if (ms <= 0) return;
  const id = setInterval(() => {
    void logCapacitySnapshot();
  }, ms);
  id.unref();
}

module.exports = {
  buildCapacityPayload,
  startCapacitySnapshotHeartbeat,
  logCapacitySnapshot,
};
