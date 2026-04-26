'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');
const logger = require('./logger');
const { overloadStageGauge } = require('./metrics');

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
// Reset the histogram periodically so p99 reflects a recent window rather
// than the lifetime average (which accumulates low-lag samples from startup
// and prevents the stage-based throttle from ever firing under load).
setInterval(() => lag.reset(), 30_000).unref();

/*
 * SKU tuning (all values are optional env overrides of the defaults below):
 *
 * ~2 GiB RAM / 1 vCPU — enter degradation before RSS crowds out the kernel /
 *   co-located Redis: e.g. OVERLOAD_RSS_WARN_MB=384, OVERLOAD_RSS_HIGH_MB=512,
 *   OVERLOAD_RSS_CRITICAL_MB=768.  HTTP-level shedding is opt-in
 *   (OVERLOAD_HTTP_SHED_ENABLED=true); stage-based throttling still applies first.
 *
 * ~8 GiB RAM / 2 vCPU (typical staging) — built-in RSS defaults (900 / 1300 /
 *   1700 MB) match a Node-only process; lower WARN if the API shares the host
 *   with Postgres or other memory-heavy services.
 *
 * Validate changes with load-tests/staging-capacity.js on the target instance.
 */

let lastStage = -1;

function toMb(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

function getThreshold(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function computeStage() {
  const forced = Number(process.env.FORCE_OVERLOAD_STAGE || '');
  if (Number.isInteger(forced) && forced >= 0 && forced <= 3) {
    return forced;
  }

  const rssMb = toMb(process.memoryUsage().rss);
  const lagP99Ms = Math.round(lag.percentile(99) / 1e6);

  const warnRss = getThreshold('OVERLOAD_RSS_WARN_MB', 900);
  const highRss = getThreshold('OVERLOAD_RSS_HIGH_MB', 1300);
  const criticalRss = getThreshold('OVERLOAD_RSS_CRITICAL_MB', 1700);

  // Thresholds calibrated for a 2-vCPU Node.js process. At 300+ VU the event
  // loop lag starts climbing from a ~5ms baseline; 20ms means we're already
  // queuing callbacks. Shedding non-critical work (stage 1: presence fanout,
  // stage 2: search indexing) at that point frees event-loop capacity for
  // actual request handlers before the pool CB needs to kick in.
  const warnLag = getThreshold('OVERLOAD_LAG_WARN_MS', 20);
  const highLag = getThreshold('OVERLOAD_LAG_HIGH_MS', 50);
  const criticalLag = getThreshold('OVERLOAD_LAG_CRITICAL_MS', 100);

  if (rssMb >= criticalRss || lagP99Ms >= criticalLag) return 3;
  if (rssMb >= highRss || lagP99Ms >= highLag) return 2;
  if (rssMb >= warnRss || lagP99Ms >= warnLag) return 1;
  return 0;
}

function getStage() {
  const stage = computeStage();
  if (stage !== lastStage) {
    lastStage = stage;
    logger.info({ stage }, 'Overload stage changed');
  }
  overloadStageGauge.set(stage);
  return stage;
}

function shouldThrottlePresenceFanout() {
  return getStage() >= 1;
}

function shouldSkipPresenceMirror() {
  return getStage() >= 2;
}

/** Stage ≥3: search router returns 429 (retry) instead of accepting work. */
function shouldRejectSearchRequests() {
  return getStage() >= 3;
}

function searchLimit(baseLimit) {
  const stage = getStage();
  // Tighter caps under load — fewer rows scanned per search (protects DB + pool).
  if (stage >= 2) return Math.min(baseLimit, 6);
  if (stage >= 1) return Math.min(baseLimit, 12);
  return baseLimit;
}

function shouldDeferSearchIndexing() {
  return getStage() >= 2;
}

function shouldRestrictNonEssentialWrites() {
  return getStage() >= 3;
}

/**
 * shouldShedIncomingRequests – **opt-in only** (`OVERLOAD_HTTP_SHED_ENABLED=true`).
 * When enabled, returns true if event-loop p99 lag exceeds OVERLOAD_LAG_SHED_MS
 * (default 250 ms). Responds with 429 + Retry-After.
 *
 * **Default is off:** without the env var set to `true`, the app absorbs load via
 * the PG pool and event-loop queue (higher tail latency, fewer artificial 503s).
 * Staging deploy sets shedding on explicitly; prod leaves it off unless you opt in.
 */
function shouldShedIncomingRequests() {
  if (process.env.OVERLOAD_HTTP_SHED_ENABLED !== 'true') return false;
  const lagP99Ms = Math.round(lag.percentile(99) / 1e6);
  return lagP99Ms >= getThreshold('OVERLOAD_LAG_SHED_MS', 250);
}

function historyLimit(baseLimit) {
  const stage = getStage();
  if (stage >= 2) return Math.min(baseLimit, 30);
  return baseLimit;
}

/**
 * Single object for logs and /health?diagnostic=1 — stable keys for tooling.
 * Calls getStage() so Prometheus gauge and stage-change logs stay accurate.
 */
function getLoadSnapshot() {
  return {
    overload_stage: getStage(),
    rss_mb: toMb(process.memoryUsage().rss),
    heap_used_mb: toMb(process.memoryUsage().heapUsed),
    event_loop_lag_p99_ms: Math.round(lag.percentile(99) / 1e6),
  };
}

module.exports = {
  getStage,
  shouldThrottlePresenceFanout,
  shouldSkipPresenceMirror,
  shouldRejectSearchRequests,
  searchLimit,
  shouldDeferSearchIndexing,
  shouldRestrictNonEssentialWrites,
  shouldShedIncomingRequests,
  historyLimit,
  getLoadSnapshot,
};
