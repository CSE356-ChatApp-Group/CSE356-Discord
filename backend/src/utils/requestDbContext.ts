'use strict';

/**
 * Per-request AsyncLocalStorage for attributing `pool.query` / wrapped `client.query`
 * calls to an HTTP request. Used with `pg_queries_per_http_request` (see `db/pool.ts`, `app.ts`).
 */

import { AsyncLocalStorage } from 'async_hooks';

type RequestDbStore = { count: number };

const als = new AsyncLocalStorage<RequestDbStore>();

export function run<T>(store: RequestDbStore, fn: () => T): T {
  return als.run(store, fn);
}

export function incrementDbQuery(): void {
  const s = als.getStore();
  if (s && typeof s.count === 'number') s.count += 1;
}
