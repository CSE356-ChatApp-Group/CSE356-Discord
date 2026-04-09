'use strict';

const client = require('prom-client');

client.register.setDefaultLabels({
  service: 'chatapp-api',
  env: process.env.NODE_ENV || 'development',
});

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_server_requests_total',
  help: 'Total number of completed HTTP requests',
  labelNames: ['method', 'route', 'status_class'],
});

const httpRequestDurationMs = new client.Histogram({
  name: 'http_server_request_duration_ms',
  help: 'Latency of completed HTTP requests in milliseconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/** Client disconnected or response aborted before `finish` (correlates with k6 status 0). */
const httpRequestsAbortedTotal = new client.Counter({
  name: 'http_server_requests_aborted_total',
  help: 'HTTP responses where the connection closed before the response finished (no finish event)',
  labelNames: ['method', 'route'],
});

/** Incremented when middleware rejects a request due to event-loop lag (overload shed). */
const httpOverloadShedTotal = new client.Counter({
  name: 'http_overload_shed_total',
  help: 'HTTP requests rejected early by event-loop lag shedding (503 before route handlers)',
});

// ── Presence fanout ────────────────────────────────────────────────────────────

/**
 * Counts every call to setPresence(), labelled by the target status and
 * whether the fanout was suppressed by the overload guard.
 *
 * Labels:
 *   status    – online | idle | away | offline
 *   throttled – true | false
 */
const presenceFanoutTotal = new client.Counter({
  name: 'presence_fanout_total',
  help: 'Number of presence state changes, partitioned by status and whether the Redis fanout was throttled',
  labelNames: ['status', 'throttled'],
});

/**
 * Distribution of how many local WebSocket clients received a message
 * when the Redis pub/sub handler fired.
 *
 * Labels:
 *   channel_type – user | channel | conversation
 */
const fanoutRecipientsHistogram = new client.Histogram({
  name: 'presence_fanout_recipients',
  help: 'Number of local WebSocket recipients per Redis pub/sub delivery, by channel type',
  labelNames: ['channel_type'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500],
});

// ── Async side-effect queue ───────────────────────────────────────────────────

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

// ── Auth cost / throttling ───────────────────────────────────────────────────

const authBcryptDurationMs = new client.Histogram({
  name: 'auth_bcrypt_duration_ms',
  help: 'Time spent performing bcrypt password hashing and comparison for auth-related flows',
  labelNames: ['operation', 'result', 'rounds'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const authRateLimitHitsTotal = new client.Counter({
  name: 'auth_rate_limit_hits_total',
  help: 'Number of auth requests rejected by the auth-specific rate limiter',
  labelNames: ['route'],
});

/** POST /messages rejected after access check (channel private / not a DM participant). */
const messagePostAccessDeniedTotal = new client.Counter({
  name: 'message_post_access_denied_total',
  help: 'Message create rejected with 403 after target access check',
  labelNames: ['reason'],
});

/** POST /api/v1/messages only — exact HTTP status (correlates with grader sendMessage failures). */
const messagePostResponseTotal = new client.Counter({
  name: 'message_post_response_total',
  help: 'POST /api/v1/messages responses by HTTP status code',
  labelNames: ['status_code'],
});

/** WebSocket connection outcomes (upgrade + auth + bootstrap failures). */
const wsConnectionResultTotal = new client.Counter({
  name: 'ws_connection_result_total',
  help: 'WebSocket outcomes after upgrade (auth failures, subscribe failures, etc.)',
  labelNames: ['result'],
});

/** Frames skipped or sockets killed due to WS send backpressure (slow consumers). */
const wsBackpressureEventsTotal = new client.Counter({
  name: 'ws_backpressure_events_total',
  help: 'WebSocket backpressure events (dropped frames or terminated slow consumers)',
  labelNames: ['action'],
});

// ── PG pool health ─────────────────────────────────────────────────────────────

const pgPoolTotal = new client.Gauge({
  name: 'pg_pool_total',
  help: 'Total number of clients in the pg pool (idle + active)',
});
const pgPoolIdle = new client.Gauge({
  name: 'pg_pool_idle',
  help: 'Number of idle clients in the pg pool',
});
const pgPoolWaiting = new client.Gauge({
  name: 'pg_pool_waiting',
  help: 'Number of requests waiting for a pg pool client (queue depth)',
});

// ── Overload stage ───────────────────────────────────────────────────────────

/**
 * Current overload stage (0–3).  Set by overload.ts on every getStage() call
 * so Grafana can alert on stage transitions without relying on log scraping.
 */
const overloadStageGauge = new client.Gauge({
  name: 'chatapp_overload_stage',
  help: 'Current load-shedding stage (0=normal 1=throttle-presence 2=shed-search 3=shed-writes)',
});

/** Call once after pool is created to start sampling every 500ms */
function startPgPoolMetrics(pool) {
  setInterval(() => {
    pgPoolTotal.set(pool.totalCount);
    pgPoolIdle.set(pool.idleCount);
    pgPoolWaiting.set(pool.waitingCount);
  }, 500).unref();
}

module.exports = {
  register: client.register,
  httpRequestsTotal,
  httpRequestDurationMs,
  httpRequestsAbortedTotal,
  httpOverloadShedTotal,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
  sideEffectQueueDepth,
  sideEffectQueueActiveWorkers,
  sideEffectQueueDelayMs,
  sideEffectJobDurationMs,
  sideEffectQueueDroppedTotal,
  overloadStageGauge,
  authBcryptDurationMs,
  authRateLimitHitsTotal,
  messagePostAccessDeniedTotal,
  messagePostResponseTotal,
  wsConnectionResultTotal,
  wsBackpressureEventsTotal,
  startPgPoolMetrics,
};
