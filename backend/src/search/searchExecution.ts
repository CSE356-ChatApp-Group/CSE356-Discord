/**
 * Postgres read-replica vs primary transaction wrapper for search queries.
 */

const db = require('../db/pool');
const { getClientTimed } = db;
const {
  logSearchDbTiming,
} = require('./searchTracing');
const {
  SEARCH_USE_READ_REPLICA,
  getSearchStatementTimeoutMs,
} = require('./searchQueryEnv');
const {
  searchDbBackendTotal,
} = require('../utils/metrics/searchPerformance');

async function runSearchQuery(
  sql: string,
  params: any[],
  options: { forcePrimary?: boolean } = {},
) {
  return withSearchClientTransaction(
    'search_query',
    options,
    async (client) => {
      const { rows } = await client.query(sql, params);
      return rows;
    },
    {
      sqlLength: sql.length,
      paramCount: params.length,
    },
    (rows: any[]) => ({ rowCount: rows.length }),
  );
}

async function withSearchClientTransaction<T>(
  kind: string,
  options: { forcePrimary?: boolean },
  run: (client: any) => Promise<T>,
  baseLogMeta: Record<string, unknown> = {},
  resultLogMeta?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const timeoutMs = getSearchStatementTimeoutMs();
  const readPool = !options.forcePrimary && SEARCH_USE_READ_REPLICA ? db.readPool : null;
  const tAll = Date.now();
  const logAndReturn = (acquireMs: number, tWork: number, out: T) => {
    const queryMs = Date.now() - tWork;
    const totalMs = Date.now() - tAll;
    logSearchDbTiming(kind, acquireMs, queryMs, totalMs, {
      ...baseLogMeta,
      ...(resultLogMeta ? resultLogMeta(out) : {}),
    });
    return out;
  };

  if (readPool) {
    const backend = 'replica';
    const tConn = Date.now();
    const client = await readPool.connect();
    const acquireMs = Date.now() - tConn;
    const tWork = Date.now();
    let rollbackErr: Error | null = null;
    try {
      await client.query('BEGIN READ ONLY');
      // set_config(..., true) is equivalent to SET LOCAL — all three in one round-trip.
      await client.query(
        `SELECT set_config('statement_timeout', $1, true),
                set_config('work_mem', '32MB', true),
                set_config('max_parallel_workers_per_gather', '0', true)`,
        [String(timeoutMs)],
      );
      const out = await run(client);
      await client.query('COMMIT');
      searchDbBackendTotal.inc({ kind, backend, result: 'success' });
      baseLogMeta.backend = backend;
      return logAndReturn(acquireMs, tWork, out);
    } catch (err) {
      searchDbBackendTotal.inc({ kind, backend, result: 'error' });
      await client.query('ROLLBACK').catch((e: any) => { rollbackErr = e; });
      throw err;
    } finally {
      // If ROLLBACK failed the connection may be in an unknown state — destroy it.
      rollbackErr ? client.release(rollbackErr) : client.release();
    }
  }

  const backend = 'primary';
  const { client, acquireMs } = await getClientTimed();
  const tWork = Date.now();
  let rollbackErr: Error | null = null;
  try {
    await client.query('BEGIN');
    // set_config(..., true) is equivalent to SET LOCAL — all three in one round-trip.
    await client.query(
      `SELECT set_config('statement_timeout', $1, true),
              set_config('work_mem', '32MB', true),
              set_config('max_parallel_workers_per_gather', '0', true)`,
      [String(timeoutMs)],
    );
    const out = await run(client);
    await client.query('COMMIT');
    searchDbBackendTotal.inc({ kind, backend, result: 'success' });
    baseLogMeta.backend = backend;
    return logAndReturn(acquireMs, tWork, out);
  } catch (err) {
    searchDbBackendTotal.inc({ kind, backend, result: 'error' });
    await client.query('ROLLBACK').catch((e: any) => { rollbackErr = e; });
    throw err;
  } finally {
    // If ROLLBACK failed the connection may be in an unknown state — destroy it.
    rollbackErr ? client.release(rollbackErr) : client.release();
  }
}

async function runSearchTransaction(
  run: (client: any) => Promise<any>,
  options: { forcePrimary?: boolean } = {},
) {
  return withSearchClientTransaction(
    'search_transaction',
    options,
    run,
  );
}

module.exports = {
  runSearchQuery,
  withSearchClientTransaction,
  runSearchTransaction,
};
