const client = require('prom-client');

/** Dual-write and bulk OpenSearch writes (single-doc index/delete/update count as docs=1 unless bulk passes doc count). */
const opensearchBulkTotal = new client.Counter({
  name: 'opensearch_bulk_total',
  help: 'OpenSearch write operations completed (single-document dual-write or /_bulk)',
  labelNames: ['result'],
});

const opensearchBulkDurationMs = new client.Histogram({
  name: 'opensearch_bulk_duration_ms',
  help: 'Wall time for OpenSearch write HTTP requests (ms)',
  labelNames: ['result'],
  buckets: [2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});

const opensearchBulkDocs = new client.Counter({
  name: 'opensearch_bulk_docs',
  help: 'Documents counted in successful OpenSearch writes',
});

const opensearchRequestErrorsTotal = new client.Counter({
  name: 'opensearch_request_errors_total',
  help: 'OpenSearch write HTTP failures or thrown client errors',
  labelNames: ['operation'],
});

type WriteOperation = 'index_doc' | 'bulk' | 'update' | 'delete' | 'create_index';

function recordOpenSearchWriteMetric(opts: {
  ms: number;
  ok: boolean;
  operation: WriteOperation;
  /** For bulk: number of source docs; for single writes defaults to 1 on success */
  docCount?: number;
}) {
  const result = opts.ok ? 'success' : 'error';
  opensearchBulkTotal.inc({ result });
  opensearchBulkDurationMs.observe({ result }, opts.ms);
  if (opts.ok) {
    const n = opts.docCount ?? (opts.operation === 'bulk' ? 0 : 1);
    if (n > 0) opensearchBulkDocs.inc(n);
  } else {
    opensearchRequestErrorsTotal.inc({ operation: opts.operation });
  }
}

function classifyOpenSearchWrite(
  path: string,
  method: string,
): { record: true; operation: WriteOperation } | { record: false } {
  const m = (method || 'GET').toUpperCase();
  if (m === 'POST' && path === '/_bulk') return { record: true, operation: 'bulk' };
  if (m === 'PUT' && /^\/[^/]+\/_doc\//.test(path)) return { record: true, operation: 'index_doc' };
  if (m === 'DELETE' && /^\/[^/]+\/_doc\//.test(path)) return { record: true, operation: 'delete' };
  if (m === 'POST' && /^\/[^/]+\/_update\//.test(path)) return { record: true, operation: 'update' };
  if (m === 'PUT' && /^\/[^/]+$/.test(path)) return { record: true, operation: 'create_index' };
  return { record: false };
}

module.exports = {
  opensearchBulkTotal,
  opensearchBulkDurationMs,
  opensearchBulkDocs,
  opensearchRequestErrorsTotal,
  recordOpenSearchWriteMetric,
  classifyOpenSearchWrite,
};
