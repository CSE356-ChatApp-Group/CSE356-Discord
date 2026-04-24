/**
 * Postgres connection pool (singleton) with circuit breaker.
 *
 * All DB access goes through the exported `query()` and `getClient()` helpers
 * rather than calling `pool.query()` / `pool.connect()` directly.  These
 * wrappers add:
 *
 *   1. Circuit breaker – immediately rejects new requests when the checkout
 *      queue exceeds POOL_CIRCUIT_BREAKER_QUEUE, preventing cascading 5 s
 *      timeout storms from building up under sustained overload.
 *
 *   2. Slow-query logging – any query exceeding PG_SLOW_QUERY_MS is logged
 *      at WARN with truncated SQL and current pool stats.
 *
 *   3. Structured error context – every pool error includes pool stats
 *      (total / idle / waiting / max) so post-mortem is instant.
 *
 * Connection target: PgBouncer (loopback :6432) in transaction-pooling mode.
 * PgBouncer caps real PG backends to a small fixed number (default_pool_size
 * in pgbouncer.ini) regardless of how many Node.js instances are running.
 * PG keepalive / NAT tricks are not needed for a loopback socket.
 *
 * Exports:
 *   pool          – raw pg-Pool (used by index.ts for metrics + graceful shutdown only)
 *   query(sql, params)             – circuit-broken single query (auto-commit)
 *   getClient()                    – circuit-broken client checkout for transactions
 *   withTransaction(callback)      – acquire client, BEGIN, run callback, COMMIT/ROLLBACK, release
 *   poolStats()                    – snapshot of pool counters (used by health check)
 *   PoolCircuitBreakerError        – error class thrown when circuit is open
 *
 * SKU tuning (env):
 *   1 vCPU — PG_POOL_MAX=10–15 and POOL_CIRCUIT_BREAKER_QUEUE≈25–40 usually match
 *   event-loop throughput; align PgBouncer default_pool_size with the sum of
 *   max connections across Node processes.
 *   2 vCPU / staging — defaults (PG_POOL_MAX=25, POOL_CIRCUIT_BREAKER_QUEUE=50)
 *   favor a longer checkout wait queue over early 503s; raise further only if
 *   PgBouncer and Postgres headroom allow.
 */

'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');
const { incrementDbQuery } = require('../utils/requestDbContext');
const { pgPoolCircuitBreakerRejectsTotal, pgPoolOperationErrorsTotal, pgQueriesTotal, pgQueryGateActive, pgQueryGateWaiting, pgQueryGateRejectsTotal } = require('../utils/metrics');

function extractSqlText(queryArg) {
  if (!queryArg) return '';
  return typeof queryArg === 'string' ? queryArg : String(queryArg.text || '');
}

function isTransactionControlSql(queryArg) {
  const text = extractSqlText(queryArg).trim().toUpperCase();
  return text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK';
}

/**
 * Count successful `client.query` calls toward the same per-request histogram as `query()`.
 *
 * Guard against re-wrapping: pg-pool reuses client objects across checkouts. Without this
 * check, each `getClient()` call stacks another wrapper around an already-wrapped `query`,
 * causing `incrementDbQuery` to fire N times after N checkouts of the same client object —
 * making `pg_business_sql_queries_per_http_request` grow linearly with pool client reuse.
 */
function wrapPoolClientForRequestMetrics(client) {
  if (client._reqMetricsWrapped) return client;
  client._reqMetricsWrapped = true;
  const origQuery = client.query.bind(client);
  client.query = function queryWrapped(...args) {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last;
      const rest = args.slice(0, -1);
      return origQuery(...rest, (err, result) => {
        if (!err) incrementDbQuery(isTransactionControlSql(rest[0]) ? 'all' : 'business_sql');
        cb(err, result);
      });
    }
    const p = origQuery(...args);
    if (p && typeof p.then === 'function') {
      return p.then((result) => {
        incrementDbQuery(isTransactionControlSql(args[0]) ? 'all' : 'business_sql');
        return result;
      });
    }
    return p;
  };
  return client;
}

function classifyPgQueryError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (
    code === 'ETIMEDOUT' ||
    (/timeout/i.test(msg) && (/connect/i.test(msg) || /acquiring/i.test(msg)))
  ) {
    return 'acquire_timeout';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return 'connection';
  if (code === '57P01' || code === '57P03') return 'shutdown';
  return 'other';
}

// ── Configuration ──────────────────────────────────────────────────────────────

/**
 * PG_POOL_MAX: connections from THIS Node.js process to PgBouncer.
 * PgBouncer handles multiplexing down to the true PG connection limit via its
 * own default_pool_size.  Keep this large enough to cover peak concurrency per
 * instance without excess; 25 is well above the ~10-15 concurrent queries a
 * single Node process can drive before the event loop becomes the bottleneck.
 */
const POOL_MAX = parseInt(process.env.PG_POOL_MAX || '25', 10);

/**
 * POOL_CIRCUIT_BREAKER_QUEUE: max number of requests allowed to wait for a
 * connection before the circuit opens and we return 503 immediately.
 * With PgBouncer in the stack, checkout latency is sub-millisecond when
 * connections are available, so a growing queue signals real DB overload.
 */
const CIRCUIT_BREAKER_QUEUE = Math.min(
  50,
  Math.max(1, parseInt(process.env.POOL_CIRCUIT_BREAKER_QUEUE || '50', 10)),
);

/**
 * PG_SLOW_QUERY_MS: queries slower than this (milliseconds) are logged at WARN.
 */
const SLOW_QUERY_MS = parseInt(process.env.PG_SLOW_QUERY_MS || '3000', 10);

/**
 * PgBouncer is a loopback socket – no NAT involved, so no keepalive needed.
 * connectionTimeoutMillis bounds how long we wait for a checkout from the
 * Node pool when all PG slots are busy. Production default 450ms fails fast
 * during DB recovery (reconnect-storm guard); non-production defaults to 8000.
 * Override with PG_CONNECTION_TIMEOUT_MS (clamped 100–10000).
 */
const _defaultPgConnTimeoutMs =
  process.env.NODE_ENV === 'production' && process.env.PG_CONNECTION_TIMEOUT_MS == null ? 450 : 8000;
const CONNECTION_TIMEOUT_MS = Math.min(
  10000,
  Math.max(
    100,
    parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || String(_defaultPgConnTimeoutMs), 10),
  ),
);

/**
 * Idle timeout for Node→PgBouncer connections.  PgBouncer manages the real
 * PG idle connections on its side; this just prevents Node from holding
 * surplus connections to PgBouncer that PgBouncer itself keeps alive.
 */
const IDLE_TIMEOUT_MS = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10);

const APPLICATION_NAME = `chatapp-${process.env.PORT || 'unknown'}`;

// ── Pool ───────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  // No keepAlive: loopback socket to PgBouncer, no NAT timeout risk.
  keepAlive: false,
  application_name: APPLICATION_NAME,
});

pool.on('error', (err) => {
  logger.error({ err, pool: poolStats() }, 'pg-pool background client error');
});

/** Optional read replica for SELECT-heavy paths (eventual consistency). */
const READ_REPLICA_URL = process.env.PG_READ_REPLICA_URL || '';
const READ_POOL_MAX = parseInt(process.env.PG_READ_POOL_MAX || '15', 10);
let readPool = null;
if (READ_REPLICA_URL) {
  readPool = new Pool({
    connectionString: READ_REPLICA_URL,
    max: Number.isFinite(READ_POOL_MAX) && READ_POOL_MAX > 0 ? READ_POOL_MAX : 15,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    keepAlive: false,
    application_name: `${APPLICATION_NAME}-read`,
  });
  readPool.on('error', (err) => {
    logger.error({ err }, 'pg read-replica pool background client error');
  });
  logger.info('PG_READ_REPLICA_URL set — queryRead() enabled for eligible SELECTs');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function poolStats() {
  return {
    total:   pool.totalCount,
    idle:    pool.idleCount,
    waiting: pool.waitingCount,
    max:     POOL_MAX,
  };
}

function truncateSql(sql) {
  if (!sql) return undefined;
  const text = typeof sql === 'string' ? sql : (sql.text || String(sql));
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// ── Circuit breaker ────────────────────────────────────────────────────────────

class PoolCircuitBreakerError extends Error {
  code: string;
  statusCode: number;
  constructor() {
    super('Database pool queue exceeded – server busy, please retry');
    this.name       = 'PoolCircuitBreakerError';
    this.code       = 'POOL_CIRCUIT_OPEN';
    this.statusCode = 503;
  }
}

function checkCircuitBreaker(operation) {
  if (pool.waitingCount >= CIRCUIT_BREAKER_QUEUE) {
    pgPoolCircuitBreakerRejectsTotal.inc();
    logger.warn({ pool: poolStats(), operation }, 'pg-pool circuit breaker open: rejected');
    throw new PoolCircuitBreakerError();
  }
}

// ── Query gate (optional concurrency limiter) ──────────────────────────────────

const QUERY_GATE_MAX = parseInt(process.env.PG_QUERY_GATE_MAX_CONCURRENT || '0', 10);
const QUERY_GATE_MAX_WAITERS = parseInt(process.env.PG_QUERY_GATE_MAX_WAITERS || '0', 10);
const QUERY_GATE_WAIT_TIMEOUT_MS = parseInt(process.env.PG_QUERY_GATE_WAIT_TIMEOUT_MS || '5000', 10);

class QueryGateSaturatedError extends Error {
  code: string;
  statusCode: number;
  constructor() {
    super('Database query gate saturated – server busy, please retry');
    this.name       = 'QueryGateSaturatedError';
    this.code       = 'PG_QUERY_GATE_SATURATED';
    this.statusCode = 503;
  }
}

let _gateActive = 0;
let _gateWaiting = 0;
const _gateWaiters: Array<() => void> = [];

function queryGateStats() {
  return { active: _gateActive, waiting: _gateWaiting };
}

async function acquireQueryGate(): Promise<void> {
  if (!QUERY_GATE_MAX) return; // gate disabled
  if (_gateActive < QUERY_GATE_MAX) {
    _gateActive++;
    pgQueryGateActive.set(_gateActive);
    return;
  }
  // At capacity — try to wait
  if (QUERY_GATE_MAX_WAITERS !== undefined && _gateWaiting >= QUERY_GATE_MAX_WAITERS) {
    pgQueryGateRejectsTotal.inc();
    throw new QueryGateSaturatedError();
  }
  await new Promise<void>((resolve, reject) => {
    _gateWaiting++;
    pgQueryGateWaiting.set(_gateWaiting);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = _gateWaiters.indexOf(admit);
      if (idx !== -1) _gateWaiters.splice(idx, 1);
      _gateWaiting--;
      pgQueryGateWaiting.set(_gateWaiting);
      pgQueryGateRejectsTotal.inc();
      reject(new QueryGateSaturatedError());
    }, QUERY_GATE_WAIT_TIMEOUT_MS);
    const admit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _gateActive++;
      pgQueryGateActive.set(_gateActive);
      resolve();
    };
    _gateWaiters.push(admit);
  });
}

function releaseQueryGate(): void {
  if (!QUERY_GATE_MAX) return;
  _gateActive--;
  pgQueryGateActive.set(_gateActive);
  if (_gateWaiters.length > 0) {
    const next = _gateWaiters.shift()!;
    _gateWaiting--;
    pgQueryGateWaiting.set(_gateWaiting);
    next();
  }
}

// ── Wrapped single query ───────────────────────────────────────────────────────

/**
 * Route read-only SELECTs to PG_READ_REPLICA_URL when set; else primary.
 * Callers must tolerate replication lag (missed very recent writes).
 */
async function queryRead(sql, params) {
  if (!readPool) return query(sql, params);
  const start = Date.now();
  try {
    const result = await readPool.query(sql, params);
    pgQueriesTotal.inc({ pool: 'read' });
    incrementDbQuery(isTransactionControlSql(sql) ? 'all' : 'business_sql');
    const durationMs = Date.now() - start;
    if (durationMs >= SLOW_QUERY_MS) {
      logger.warn({ durationMs, sql: truncateSql(sql), pool: 'read' }, 'pg read replica: slow query');
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = classifyPgQueryError(err);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason });
    logger.error(
      { err, durationMs, sql: truncateSql(sql), pool: 'read', pgErrorReason: reason },
      'pg: read replica query error',
    );
    throw err;
  }
}

async function query(sql, params) {
  checkCircuitBreaker('query');
  await acquireQueryGate();
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    pgQueriesTotal.inc({ pool: 'primary' });
    incrementDbQuery(isTransactionControlSql(sql) ? 'all' : 'business_sql');
    const durationMs = Date.now() - start;
    if (durationMs >= SLOW_QUERY_MS) {
      logger.warn({ durationMs, sql: truncateSql(sql), pool: poolStats() }, 'pg: slow query');
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = classifyPgQueryError(err);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason });
    logger.error(
      { err, durationMs, sql: truncateSql(sql), pool: poolStats(), pgErrorReason: reason },
      'pg: query error',
    );
    throw err;
  } finally {
    releaseQueryGate();
  }
}

// ── Wrapped client checkout ────────────────────────────────────────────────────

async function getClient() {
  checkCircuitBreaker('getClient');
  await acquireQueryGate();
  let client;
  try {
    client = wrapPoolClientForRequestMetrics(await pool.connect());
  } catch (err) {
    releaseQueryGate();
    throw err;
  }
  const origRelease = client.release.bind(client);
  let released = false;
  client.release = (...args) => {
    if (!released) { released = true; releaseQueryGate(); }
    return origRelease(...args);
  };
  return client;
}

/** Checkout + `acquire_ms` (ms waiting for a pool slot from PgBouncer). */
async function getClientTimed() {
  checkCircuitBreaker('getClientTimed');
  const t = Date.now();
  const client = wrapPoolClientForRequestMetrics(await pool.connect());
  return { client, acquireMs: Date.now() - t };
}

// ── Transaction convenience wrapper ───────────────────────────────────────────

/**
 * Runs `callback(client)` inside a transaction.
 * The caller must not release the client; withTransaction handles that.
 * Any exception thrown by the callback causes a ROLLBACK.
 */
async function withTransaction(callback) {
  checkCircuitBreaker('withTransaction');
  const client = wrapPoolClientForRequestMetrics(await pool.connect());
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  readPool,
  query,
  queryRead,
  getClient,
  getClientTimed,
  withTransaction,
  poolStats,
  queryGateStats,
  PoolCircuitBreakerError,
};
