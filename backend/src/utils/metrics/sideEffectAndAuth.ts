/**
 * Async side-effect queue + auth bcrypt / auth rate-limit metrics.
 */

const client = require('prom-client');

const sideEffectQueueDepth = new client.Gauge({
  name: 'side_effect_queue_depth',
  help: 'Number of pending async side-effect jobs waiting to be processed',
  labelNames: ['queue'],
});

const sideEffectQueueActiveWorkers = new client.Gauge({
  name: 'side_effect_queue_active_workers',
  help: 'Number of workers currently draining the async side-effect queue',
  labelNames: ['queue'],
});

const sideEffectQueueDelayMs = new client.Histogram({
  name: 'side_effect_queue_delay_ms',
  help: 'Time a side-effect job spends waiting in the queue before execution',
  labelNames: ['queue', 'name'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const sideEffectJobDurationMs = new client.Histogram({
  name: 'side_effect_job_duration_ms',
  help: 'Execution time of async side-effect jobs',
  labelNames: ['queue', 'name', 'status'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const sideEffectQueueDroppedTotal = new client.Counter({
  name: 'side_effect_queue_dropped_total',
  help: 'Number of side-effect jobs dropped before execution due to overload safeguards',
  labelNames: ['queue', 'name', 'reason'],
});

const authBcryptDurationMs = new client.Histogram({
  name: 'auth_bcrypt_duration_ms',
  help: 'Time spent performing bcrypt password hashing and comparison for auth-related flows',
  labelNames: ['operation', 'result', 'rounds'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const authBcryptActive = new client.Gauge({
  name: 'auth_bcrypt_active',
  help: 'Number of bcrypt operations currently executing inside the app-level bcrypt gate',
});

const authBcryptWaiters = new client.Gauge({
  name: 'auth_bcrypt_waiters',
  help: 'Number of bcrypt operations currently waiting in the app-level bcrypt queue',
});

const authBcryptQueueRejectsTotal = new client.Counter({
  name: 'auth_bcrypt_queue_rejects_total',
  help: 'Number of bcrypt operations rejected or timed out before execution',
  labelNames: ['reason'],
});

const authRateLimitHitsTotal = new client.Counter({
  name: 'auth_rate_limit_hits_total',
  help: 'Number of auth requests rejected by the auth-specific rate limiter',
  labelNames: ['route'],
});

const authSessionFlowTotal = new client.Counter({
  name: 'auth_session_flow_total',
  help: 'Auth/session lifecycle outcomes split by request path, mode, and result',
  labelNames: ['path', 'mode', 'result'],
});

module.exports = {
  sideEffectQueueDepth,
  sideEffectQueueActiveWorkers,
  sideEffectQueueDelayMs,
  sideEffectJobDurationMs,
  sideEffectQueueDroppedTotal,
  authBcryptDurationMs,
  authBcryptActive,
  authBcryptWaiters,
  authBcryptQueueRejectsTotal,
  authRateLimitHitsTotal,
  authSessionFlowTotal,
};
