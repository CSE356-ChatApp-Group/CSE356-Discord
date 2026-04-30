
/**
 * Optional structured log for slow HTTP requests (excluding message routes by default),
 * with per-request DB wall-time aggregates from AsyncLocalStorage (see requestDbContext).
 */

const os = require('os');
const logger = require('./logger');

function parseMinMs() {
  const v = Number.parseInt(process.env.SLOW_HTTP_TRACE_MIN_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function parseExcludePrefixes() {
  const raw =
    process.env.SLOW_HTTP_TRACE_EXCLUDE_PREFIXES ||
    '/api/v1/messages,/health,/metrics';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const SLOW_HTTP_TRACE_MIN_MS = parseMinMs();
const EXCLUDE_PREFIXES = parseExcludePrefixes();

function pathShouldExclude(route, rawPath) {
  for (const p of EXCLUDE_PREFIXES) {
    if (!p) continue;
    if (route.startsWith(p) || rawPath.startsWith(p)) return true;
  }
  return false;
}

/**
 * @param {object} args
 * @param {import('./requestDbContext').RequestDbStore} args.store
 */
function maybeLogSlowHttpRequestTrace(args) {
  const { req, res, store, durationMs, route } = args;
  if (SLOW_HTTP_TRACE_MIN_MS <= 0) return;
  if (durationMs < SLOW_HTTP_TRACE_MIN_MS) return;
  const rawPath = String(req.originalUrl || req.url || '').split('?')[0] || '';
  if (pathShouldExclude(route, rawPath)) return;

  const dbSum = Number(store.totalDbMs) || 0;
  const dbMax = Number(store.maxDbMs) || 0;
  const overlap = dbSum > durationMs * 1.05;
  const appEstimated = overlap ? undefined : Math.max(0, durationMs - dbSum);

  logger.warn(
    {
      event: 'slow_http_request_trace',
      gradingNote: 'correlate_with_pg_stat_statements_and_redis_slowlog',
      requestId: req.id,
      route,
      method: req.method,
      status_code: res.statusCode,
      worker_id: `${os.hostname()}:${process.env.PORT || '?'}`,
      total_wall_ms: Math.round(durationMs * 100) / 100,
      db_query_count: store.count,
      db_business_sql_count: store.sqlCount,
      db_sum_ms: Math.round(dbSum * 100) / 100,
      db_max_single_ms: Math.round(dbMax * 100) / 100,
      app_wall_ms_estimated:
        appEstimated === undefined
          ? undefined
          : Math.round(appEstimated * 100) / 100,
      db_wall_parallel_overlap_hint: overlap || undefined,
      db_query_samples: store.dbSamples,
      correlate_pg_stat_statements:
        'DB_SSH=user@db-host ./scripts/postgres/pg-stat-statements-snapshot.sh',
      explain_workflow: 'docs/operations-monitoring.md#slow-route-explain-workflow',
    },
    'Slow HTTP request (SLOW_HTTP_TRACE_MIN_MS) outside excluded path prefixes',
  );
}

module.exports = { maybeLogSlowHttpRequestTrace };
