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
    const tConn = Date.now();
    const client = await readPool.connect();
    const acquireMs = Date.now() - tConn;
    const tWork = Date.now();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL work_mem = '64MB'`);
      await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
      const out = await run(client);
      await client.query('COMMIT');
      return logAndReturn(acquireMs, tWork, out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const { client, acquireMs } = await getClientTimed();
  const tWork = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL work_mem = '64MB'`);
    await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
    const out = await run(client);
    await client.query('COMMIT');
    return logAndReturn(acquireMs, tWork, out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
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
