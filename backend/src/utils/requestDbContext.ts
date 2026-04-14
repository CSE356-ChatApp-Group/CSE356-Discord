'use strict';

/**
 * Per-request AsyncLocalStorage for attributing `pool.query` / wrapped `client.query`
 * calls to an HTTP request. Used with `pg_queries_per_http_request` (see `db/pool.ts`, `app.ts`).
 */

import { AsyncLocalStorage } from 'async_hooks';

type QueryKind = 'all' | 'business_sql';
type RequestDbStore = { count: number; sqlCount: number };

const als = new AsyncLocalStorage<RequestDbStore>();

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
