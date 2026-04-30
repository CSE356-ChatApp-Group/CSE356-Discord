
/**
 * Per-request AsyncLocalStorage for attributing `pool.query` / wrapped `client.query`
 * calls to an HTTP request. Used with `pg_queries_per_http_request` (see `db/pool.ts`, `app.ts`).
 */

import { AsyncLocalStorage } from 'async_hooks';

type QueryKind = 'all' | 'business_sql';

export type RequestDbStore = {
  count: number;
  sqlCount: number;
  /** Sum of observed round-trip query times (can exceed request wall if queries overlap). */
  totalDbMs: number;
  maxDbMs: number;
  /** Last few statements for slow-request logs (truncated SQL). */
  dbSamples: Array<{ ms: number; sql: string; pool: 'primary' | 'read' }>;
};

const als = new AsyncLocalStorage<RequestDbStore>();
const MAX_DB_SAMPLES = 30;

export function createRequestDbStore(): RequestDbStore {
  return { count: 0, sqlCount: 0, totalDbMs: 0, maxDbMs: 0, dbSamples: [] };
}

export function run<T>(store: RequestDbStore, fn: () => T): T {
  return als.run(store, fn);
}

export function incrementDbQuery(kind: QueryKind = 'all'): void {
  const s = als.getStore();
  if (!s || typeof s.count !== 'number') return;
  s.count += 1;
  if (kind === 'business_sql' && typeof s.sqlCount === 'number') {
    s.sqlCount += 1;
  }
}

/** Record wall time for a completed `pool.query` / `client.query` (primary or read replica). */
export function recordDbQueryWall(
  durationMs: number,
  sqlText: string,
  pool: 'primary' | 'read',
): void {
  const s = als.getStore();
  if (!s || typeof s.totalDbMs !== 'number') return;
  const ms = Math.max(0, Number(durationMs) || 0);
  s.totalDbMs += ms;
  if (ms > s.maxDbMs) s.maxDbMs = ms;
  if (s.dbSamples.length >= MAX_DB_SAMPLES) return;
  const t = String(sqlText || '').trim();
  const up = t.toUpperCase();
  if (up === 'BEGIN' || up === 'COMMIT' || up === 'ROLLBACK') return;
  const oneLine = t.replace(/\s+/g, ' ');
  const sql = oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
  s.dbSamples.push({ ms, sql, pool });
}
