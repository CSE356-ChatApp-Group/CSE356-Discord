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


const { Pool } = require('pg');
const logger = require('../utils/logger');
const { incrementDbQuery, recordDbQueryWall } = require('../utils/requestDbContext');
const { pgPoolCircuitBreakerRejectsTotal, pgPoolOperationErrorsTotal, pgQueriesTotal, pgQueryGateActive, pgQueryGateWaiting, pgQueryGateRejectsTotal } = require('../utils/metrics');
const { tracer } = require('../utils/tracer');
const { SpanStatusCode } = require('@opentelemetry/api');

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
/** Optional low-cardinality fields merged into slow / fallback / read-replica error logs only. */
type ReadDiagnostics = Record<string, string | number | boolean>;

type QueryOpts = {
  readDiagnostics?: ReadDiagnostics;
  /** Invoked when read replica fails in a way that triggers transparent primary retry (no throw). */
  onReadReplicaFallback?: (info: { durationMs: number }) => void;
};

function readDiagnosticsForLog(d: ReadDiagnostics | undefined): ReadDiagnostics {
  if (!d || typeof d !== 'object') return {};
  const out: ReadDiagnostics = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined && v !== null) out[k] = v as string | number | boolean;
  }
  return out;
}

function wrapPoolClientForRequestMetrics(client) {
  if (client._reqMetricsWrapped) return client;
  client._reqMetricsWrapped = true;
  const origQuery = client.query.bind(client);
  client.query = function queryWrapped(...args) {
    const t0 = Date.now();
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const cb = last;
      const rest = args.slice(0, -1);
      return origQuery(...rest, (err, result) => {
        if (!err) {
          recordDbQueryWall(Date.now() - t0, extractSqlText(rest[0]), 'primary');
          incrementDbQuery(isTransactionControlSql(rest[0]) ? 'all' : 'business_sql');
        }
        cb(err, result);
      });
    }
    const p = origQuery(...args);
    if (p && typeof p.then === 'function') {
      return p.then((result) => {
        recordDbQueryWall(Date.now() - t0, extractSqlText(args[0]), 'primary');
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
    code === '57014' ||
    /query read timeout|query timeout|statement timeout|canceling statement due to statement timeout/i.test(msg)
  ) {
    return 'query_timeout';
  }
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

/** True when the read pool failed in a way that should transparently use the primary. */
function shouldFallbackReadReplicaToPrimary(err) {
  const reason = classifyPgQueryError(err);
  if (
    reason === 'connection' ||
    reason === 'acquire_timeout' ||
    reason === 'query_timeout' ||
    reason === 'shutdown'
  ) {
    return true;
  }
  const c = err && err.code;
  if (c === '08006' || c === '08001' || c === '08003' || c === '53300') return true;
  const msg = String((err && err.message) || '');
  return /connection refused|connection reset|connection timed out|connection terminated|no pg_hba|ECONNREFUSED|socket hang up/i.test(
    msg,
  );
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
  100,
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
const READ_QUERY_TIMEOUT_MS = parseInt(process.env.PG_READ_QUERY_TIMEOUT_MS || '0', 10);
const SEARCH_READ_POOL_MAX = parseInt(
  process.env.PG_SEARCH_READ_POOL_MAX || '4',
  10,
);
const SEARCH_STATEMENT_TIMEOUT_MS = Math.min(
  2000,
  Math.max(1500, parseInt(process.env.SEARCH_STATEMENT_TIMEOUT_MS || '2000', 10) || 2000),
);
let readPool = null;
let searchReadPool = null;
if (READ_REPLICA_URL) {
  readPool = new Pool({
    connectionString: READ_REPLICA_URL,
    max: Number.isFinite(READ_POOL_MAX) && READ_POOL_MAX > 0 ? READ_POOL_MAX : 15,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    ...(Number.isFinite(READ_QUERY_TIMEOUT_MS) && READ_QUERY_TIMEOUT_MS > 0
      ? { query_timeout: READ_QUERY_TIMEOUT_MS }
      : {}),
    keepAlive: false,
    application_name: `${APPLICATION_NAME}-read`,
  });
  readPool.on('error', (err) => {
    logger.error({ err }, 'pg read-replica pool background client error');
  });
  logger.info('PG_READ_REPLICA_URL set — queryRead() enabled for eligible SELECTs');

  searchReadPool = new Pool({
    connectionString: READ_REPLICA_URL,
    max: Number.isFinite(SEARCH_READ_POOL_MAX) && SEARCH_READ_POOL_MAX > 0 ? SEARCH_READ_POOL_MAX : 4,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    query_timeout: SEARCH_STATEMENT_TIMEOUT_MS + 250,
    keepAlive: false,
    application_name: `${APPLICATION_NAME}-search-read`,
    options: `-c statement_timeout=${SEARCH_STATEMENT_TIMEOUT_MS} -c work_mem=32MB -c max_parallel_workers_per_gather=0`,
  });
  searchReadPool.on('error', (err) => {
    logger.error({ err }, 'pg search read-replica pool background client error');
  });
  logger.info(
    {
      statementTimeoutMs: SEARCH_STATEMENT_TIMEOUT_MS,
      max: Number.isFinite(SEARCH_READ_POOL_MAX) && SEARCH_READ_POOL_MAX > 0 ? SEARCH_READ_POOL_MAX : 4,
    },
    'PG_READ_REPLICA_URL set — dedicated search read pool enabled',
  );
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
 *
 * On replica **transport** failures (refused, timeout, shutdown), falls back to
 * `query()` on the primary so hot paths do not 500 when the standby is down.
 * Set `PG_READ_FALLBACK_TO_PRIMARY=false` to disable fallback (fail fast).
 */
async function queryRead(sql: unknown, params?: unknown, opts?: QueryOpts) {
  if (!readPool) return query(sql, params, opts);
  const diag = readDiagnosticsForLog(opts?.readDiagnostics);
  const readFallbackEnabled = process.env.PG_READ_FALLBACK_TO_PRIMARY !== 'false';
  const start = Date.now();
  try {
    const result = await readPool.query(sql as any, params as any);
    const durationMs = Date.now() - start;
    recordDbQueryWall(durationMs, extractSqlText(sql), 'read');
    pgQueriesTotal.inc({ pool: 'read' });
    incrementDbQuery(isTransactionControlSql(sql) ? 'all' : 'business_sql');
    if (durationMs >= SLOW_QUERY_MS) {
      const baseSlow = { durationMs, sql: truncateSql(sql), pool: 'read' };
      logger.warn(
        Object.keys(diag).length ? { ...baseSlow, readPoolLeg: 'replica', ...diag } : baseSlow,
        'pg read replica: slow query',
      );
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = classifyPgQueryError(err);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason });
    if (readFallbackEnabled && shouldFallbackReadReplicaToPrimary(err)) {
      const baseWarn = {
        err,
        durationMs,
        replicaLegDurationMs: durationMs,
        sql: truncateSql(sql),
        pool: 'read',
        pgErrorReason: reason,
      };
      if (typeof opts?.onReadReplicaFallback === 'function') {
        try {
          opts.onReadReplicaFallback({ durationMs });
        } catch {
          // Metrics / caller hooks must not affect fallback.
        }
      }
      logger.warn(
        Object.keys(diag).length ? { ...baseWarn, readPoolLeg: 'replica', ...diag } : baseWarn,
        'pg: read replica unavailable; falling back to primary for this SELECT',
      );
      const continuation: QueryOpts | undefined =
        Object.keys(diag).length > 0
          ? {
              readDiagnostics: {
                ...diag,
                readPoolLeg: 'primary',
                targetLookupReplicaFallback: true,
                replicaLegDurationMs: durationMs,
                replicaLegPgErrorReason: reason,
              },
            }
          : undefined;
      return query(sql, params, continuation);
    }
    const baseErr = { err, durationMs, sql: truncateSql(sql), pool: 'read', pgErrorReason: reason };
    logger.error(
      Object.keys(diag).length ? { ...baseErr, readPoolLeg: 'replica', ...diag } : baseErr,
      'pg: read replica query error',
    );
    throw err;
  }
}

async function query(sql: unknown, params?: unknown, opts?: QueryOpts) {
  const diag = readDiagnosticsForLog(opts?.readDiagnostics);
  checkCircuitBreaker('query');
  await acquireQueryGate();
  const start = Date.now();
  try {
    const result = await pool.query(sql as any, params as any);
    const durationMs = Date.now() - start;
    recordDbQueryWall(durationMs, extractSqlText(sql), 'primary');
    pgQueriesTotal.inc({ pool: 'primary' });
    incrementDbQuery(isTransactionControlSql(sql) ? 'all' : 'business_sql');
    if (durationMs >= SLOW_QUERY_MS) {
      const baseSlow = { durationMs, sql: truncateSql(sql), pool: poolStats() };
      logger.warn(
        Object.keys(diag).length ? { ...baseSlow, ...diag } : baseSlow,
        'pg: slow query',
      );
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    const reason = classifyPgQueryError(err);
    pgPoolOperationErrorsTotal.inc({ operation: 'query', reason });
    const baseErr = { err, durationMs, sql: truncateSql(sql), pool: poolStats(), pgErrorReason: reason };
    logger.error(
      Object.keys(diag).length ? { ...baseErr, ...diag } : baseErr,
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
  const waitingBefore = pool.waitingCount;
  const t0 = Date.now();
  let client: any;
  try {
    client = await tracer.startActiveSpan('db.pool_checkout', async (span: any) => {
      try {
        span.setAttribute('pool.waiting_count_before', waitingBefore);
        span.setAttribute('pool.total', pool.totalCount);
        span.setAttribute('pool.idle', pool.idleCount);
        span.setAttribute('pool.max', POOL_MAX);
        const c = wrapPoolClientForRequestMetrics(await pool.connect());
        span.setAttribute('pool.acquire_ms', Date.now() - t0);
        return c;
      } catch (err: any) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
        span.recordException(err);
        throw err;
      } finally {
        span.end();
      }
    });
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
async function withTransaction(callback, opts?: { onCheckout?: (acquireMs: number) => void }) {
  checkCircuitBreaker('withTransaction');
  const waitingBefore = pool.waitingCount;
  const t0 = Date.now();
  const client: any = await tracer.startActiveSpan('db.pool_checkout', async (span: any) => {
    try {
      span.setAttribute('pool.waiting_count_before', waitingBefore);
      span.setAttribute('pool.total', pool.totalCount);
      span.setAttribute('pool.idle', pool.idleCount);
      span.setAttribute('pool.max', POOL_MAX);
      const c = wrapPoolClientForRequestMetrics(await pool.connect());
      const acquireMs = Date.now() - t0;
      span.setAttribute('pool.acquire_ms', acquireMs);
      opts?.onCheckout?.(acquireMs);
      return c;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
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
  searchReadPool,
  query,
  queryRead,
  getClient,
  getClientTimed,
  withTransaction,
  poolStats,
  queryGateStats,
  PoolCircuitBreakerError,
};
