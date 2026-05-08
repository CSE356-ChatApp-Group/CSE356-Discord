/**
 * Community member-count counters plus browser RUM/web-vitals metrics.
 */

const client = require('prom-client');

const communityCountRedisUpdateTotal = new client.Counter({
  name: 'community_count_redis_update_total',
  help: 'Community member count Redis HINCRBY outcomes (join/leave hot path)',
  labelNames: ['result'],
});

const communityCountPgReconcileTotal = new client.Counter({
  name: 'community_count_pg_reconcile_total',
  help: 'Community member count DB reconcile batch outcomes',
  labelNames: ['result'],
});

const communityCountPgReconcileSkippedTotal = new client.Counter({
  name: 'community_count_pg_reconcile_skipped_total',
  help: 'Community member count DB reconcile skipped by reason',
  labelNames: ['reason'],
});

const communityCountCacheTotal = new client.Counter({
  name: 'community_count_cache_total',
  help: 'Community member count Redis HMGET read outcomes',
  labelNames: ['result'],
});

/**
 * `POST /api/v1/communities/:id/join` Redis fast-path outcomes.
 *   hit         — SISMEMBER said member; INSERT + fan-out skipped
 *   miss        — cache cold; INSERT inserted a new row
 *   repopulate  — cache cold; INSERT was a no-op (DB already had the row)
 *   error       — Redis unavailable; fell through to slow path
 */
const communityJoinCacheTotal = new client.Counter({
  name: 'community_join_cache_total',
  help: 'Community-join idempotent fast-path outcomes (per-user membership Redis cache)',
  labelNames: ['result'],
});

/** Browser timing vitals (LCP, INP, FCP, TTFB) in seconds. */
const clientWebVitalTimingSeconds = new client.Histogram({
  name: 'client_web_vital_timing_seconds',
  help: 'Browser timing web vitals (seconds)',
  labelNames: ['name'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
});

/** Cumulative Layout Shift score (0–1, dimensionless). */
const clientWebVitalClsScore = new client.Histogram({
  name: 'client_web_vital_cls_score',
  help: 'Cumulative Layout Shift (CLS) scores from optional RUM',
  labelNames: ['name'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
});

const clientRumBatchesTotal = new client.Counter({
  name: 'client_rum_batches_total',
  help: 'Accepted browser RUM report batches (ENABLE_CLIENT_RUM)',
});

module.exports = {
  communityCountRedisUpdateTotal,
  communityCountPgReconcileTotal,
  communityCountPgReconcileSkippedTotal,
  communityCountCacheTotal,
  communityJoinCacheTotal,
  clientWebVitalTimingSeconds,
  clientWebVitalClsScore,
  clientRumBatchesTotal,
};
