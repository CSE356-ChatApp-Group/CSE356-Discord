/**
 * PG pool health, query-gate, and list-endpoint cache metrics.
 */

const client = require('prom-client');

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

/** Total successful Postgres queries executed across all pools (primary + read). */
const pgQueriesTotal = new client.Counter({
  name: 'pg_queries_total',
  help: 'Total number of successful Postgres queries executed',
  labelNames: ['pool'],
});

/** Immediate rejects when checkout queue hits POOL_CIRCUIT_BREAKER_QUEUE (scale DB vs app). */
const pgPoolCircuitBreakerRejectsTotal = new client.Counter({
  name: 'pg_pool_circuit_breaker_rejects_total',
  help: 'Requests rejected because the pg pool waiting queue exceeded the circuit breaker threshold',
});

const pgQueryGateActive = new client.Gauge({
  name: 'pg_query_gate_active',
  help: 'Number of queries currently passing through the query gate',
});

const pgQueryGateWaiting = new client.Gauge({
  name: 'pg_query_gate_waiting',
  help: 'Number of queries waiting at the query gate',
});

const pgQueryGateRejectsTotal = new client.Counter({
  name: 'pg_query_gate_rejects_total',
  help: 'Queries rejected by the query gate due to saturation',
});

/**
 * Errors from pool.query after checkout (timeouts, refused, etc.).
 * Use this with pg_pool_waiting and circuit_breaker_rejects to see whether bursts are DB path vs JS.
 */
const pgPoolOperationErrorsTotal = new client.Counter({
  name: 'pg_pool_operation_errors_total',
  help: 'Errors from pg pool operations, by coarse reason',
  labelNames: ['operation', 'reason'],
});

/**
 * Count of successful `query()` / wrapped `client.query()` round-trips per HTTP request
 * (AsyncLocalStorage). Includes BEGIN/COMMIT/ROLLBACK from transactions. Simple reads can be
 * single digits; heavy routes (e.g. `/api/v1/messages/`) often land much higher — interpret high p95
 * only when histogram buckets extend above observed values (otherwise quantiles clip at the top bucket).
 */
const pgQueriesPerRequestHistogram = new client.Histogram({
  name: 'pg_queries_per_http_request',
  help: 'Successful Postgres round-trips per HTTP request (includes txn control statements)',
  labelNames: ['route'],
  buckets: [
    0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377,
    610, 987, 1597, 2584, 4181, 6765, 10946,
  ],
});
const pgBusinessSqlQueriesPerRequestHistogram = new client.Histogram({
  name: 'pg_business_sql_queries_per_http_request',
  help: 'Successful Postgres business-SQL round-trips per HTTP request (excludes BEGIN/COMMIT/ROLLBACK)',
  labelNames: ['route'],
  buckets: [
    0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377,
    610, 987, 1597, 2584, 4181, 6765, 10946,
  ],
});

/** Redis-backed list endpoint cache: hit (served from Redis), miss (DB load), coalesced (singleflight waiter). */
const endpointListCacheTotal = new client.Counter({
  name: 'endpoint_list_cache_total',
  help: 'Redis list cache outcomes for hot GET list endpoints',
  labelNames: ['endpoint', 'result'],
});

/** First-page GET /messages cache skipped a Redis write (e.g. epoch bumped during load). */
const messageListCacheStoreSkippedTotal = new client.Counter({
  name: 'message_list_cache_store_skipped_total',
  help: 'Skipped writing Redis JSON for first-page message list cache after DB load',
  labelNames: ['scope', 'reason'],
});
const endpointListCacheBypassTotal = new client.Counter({
  name: 'endpoint_list_cache_bypass_total',
  help: 'Redis list cache bypasses by endpoint and reason',
  labelNames: ['endpoint', 'reason'],
});
const endpointListCacheInvalidationsTotal = new client.Counter({
  name: 'endpoint_list_cache_invalidations_total',
  help: 'Redis list cache invalidations by endpoint and reason',
  labelNames: ['endpoint', 'reason'],
});

/** GET /messages access check shortcuts from scoped channel access cache. */
const messagesListAccessCacheHitTotal = new client.Counter({
  name: 'messages_list_access_cache_hit_total',
  help: 'GET /messages requests that reused a cached channel access decision',
  labelNames: ['path'],
});

/** API route rate limiters that intentionally shed abusive traffic before hot paths. */
const apiRateLimitHitsTotal = new client.Counter({
  name: 'api_rate_limit_hits_total',
  help: 'Requests rejected by API route rate limiters, labelled by limiter scope',
  labelNames: ['scope'],
});

/** Call once after pool is created to start sampling every 500ms */
function startPgPoolMetrics(pool) {
  const logger = require('../logger');
  const circuitMax = parseInt(process.env.POOL_CIRCUIT_BREAKER_QUEUE || '50', 10);
  const highWatermark = Math.max(8, Math.floor(circuitMax * 0.25));
  let queueElevatedLogged = false;

  setInterval(() => {
    const waiting = pool.waitingCount;
    pgPoolTotal.set(pool.totalCount);
    pgPoolIdle.set(pool.idleCount);
    pgPoolWaiting.set(waiting);

    if (waiting >= highWatermark) {
      if (!queueElevatedLogged) {
        queueElevatedLogged = true;
        logger.warn(
          {
            poolWaiting: waiting,
            highWatermark,
            circuitMax,
            port: process.env.PORT,
            msg: 'pg pool checkout queue elevated — correlate with pg_pool_operation_errors_total and PgBouncer SHOW POOLS',
          },
          'pg_pool_queue_elevated',
        );
      }
    } else if (waiting <= Math.max(1, Math.floor(highWatermark / 2))) {
      queueElevatedLogged = false;
    }
  }, 500).unref();
}

module.exports = {
  pgPoolTotal,
  pgPoolIdle,
  pgPoolWaiting,
  pgQueriesTotal,
  pgPoolCircuitBreakerRejectsTotal,
  pgQueryGateActive,
  pgQueryGateWaiting,
  pgQueryGateRejectsTotal,
  pgPoolOperationErrorsTotal,
  pgQueriesPerRequestHistogram,
  pgBusinessSqlQueriesPerRequestHistogram,
  endpointListCacheTotal,
  messageListCacheStoreSkippedTotal,
  endpointListCacheBypassTotal,
  endpointListCacheInvalidationsTotal,
  messagesListAccessCacheHitTotal,
  apiRateLimitHitsTotal,
  startPgPoolMetrics,
};
