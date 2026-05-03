/**
 * Bootstrap hydration scheduler — rate-limits post-ready subscription hydration
 * to prevent reconnect storms from blocking live realtime message delivery.
 *
 * Design:
 *   • Per-worker hydration concurrency cap (env WS_BOOTSTRAP_HYDRATION_MAX_CONCURRENT).
 *   • Jittered scheduling to smooth post-ready hydration bursts.
 *   • Yields to live fanout when `signalLiveFanoutPending()` is called.
 *   • Coalesces repeated hydration for the same user within a short window.
 *
 * Metrics emitted:
 *   ws_bootstrap_hydration_queue_depth
 *   ws_bootstrap_hydration_delay_ms
 *   ws_bootstrap_hydration_active
 *   ws_bootstrap_hydration_deferred_total
 *   ws_bootstrap_coalesced_total
 *   ws_bootstrap_channel_list_cache_total (augmented)
 *   ws_live_fanout_starvation_guard_total
 *   ws_bootstrap_paused_for_live_fanout_total
 */

type HydrationResult =
  | { status: 'hydrated' }
  | { status: 'skipped'; reason: string };

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

// ── Config ────────────────────────────────────────────────────────────────────
const HYDRATION_MAX_CONCURRENT = parseIntEnv('WS_BOOTSTRAP_HYDRATION_MAX_CONCURRENT', 8, 1, 64);
const HYDRATION_BATCH_INTERVAL_MS = parseIntEnv('WS_BOOTSTRAP_HYDRATION_BATCH_INTERVAL_MS', 50, 10, 500);
const HYDRATION_JITTER_MAX_MS = parseIntEnv('WS_BOOTSTRAP_HYDRATION_JITTER_MAX_MS', 100, 0, 500);
const COALESCE_WINDOW_MS = parseIntEnv('WS_BOOTSTRAP_COALESCE_WINDOW_MS', 5000, 1000, 30000);
const LIVE_FANOUT_YIELD_MS = parseIntEnv('WS_BOOTSTRAP_LIVE_FANOUT_YIELD_MS', 20, 5, 200);
const PROTECTION_ENABLED = parseBoolEnv('WS_BOOTSTRAP_STORM_PROTECTION_ENABLED', true);

function createBootstrapHydrationScheduler(metrics: {
  wsBootstrapHydrationQueueDepth?: any;
  wsBootstrapHydrationDelayMs?: any;
  wsBootstrapHydrationActive?: any;
  wsBootstrapHydrationDeferredTotal?: any;
  wsBootstrapHydrationSkippedTotal?: any;
  wsBootstrapHydrationCooldownActive?: any;
  wsBootstrapCoalescedTotal?: any;
  wsLiveFanoutStarvationGuardTotal?: any;
  wsBootstrapPausedForLiveFanoutTotal?: any;
}) {
  // ── State ───────────────────────────────────────────────────────────────────
  let activeHydrations = 0;
  const pendingQueue: Array<{
    ws: any;
    userId: string;
    channels: string[];
    resolve: (result: HydrationResult) => void;
    reject: (err: Error) => void;
    enqueuedAt: number;
    fingerprint: string;
  }> = [];

  const inFlightByUser = new Map<string, Promise<HydrationResult>>();
  const recentHydrations = new Map<string, { hydratedAt: number; fingerprint: string }>();

  // Live fanout pressure signal
  let liveFanoutPendingCount = 0;
  let liveFanoutSignalAt = 0;

  let draining = false;

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitterMs(): number {
    return Math.floor(Math.random() * (HYDRATION_JITTER_MAX_MS + 1));
  }

  function metricInc(metric: any, labels?: Record<string, string>, value?: number) {
    if (!metric) return;
    if (typeof metric.inc === 'function') {
      metric.inc(labels, value);
      return;
    }
    if (typeof metric === 'function') {
      metric(labels, value);
    }
  }

  function metricSet(metric: any, value: number) {
    if (!metric) return;
    if (typeof metric.set === 'function') {
      metric.set(value);
      return;
    }
    if (typeof metric === 'function') {
      metric(value);
    }
  }

  function metricObserve(metric: any, value: number) {
    if (!metric) return;
    if (typeof metric.observe === 'function') {
      metric.observe(value);
      return;
    }
    if (typeof metric === 'function') {
      metric(value);
    }
  }

  function channelFingerprint(channels: string[]): string {
    if (!Array.isArray(channels) || channels.length === 0) return '0:';
    const normalized = channels
      .filter((value) => typeof value === 'string')
      .slice()
      .sort();
    return `${normalized.length}:${normalized.join('\n')}`;
  }

  function pruneRecentHydrations(nowMs = Date.now()) {
    const cutoff = nowMs - COALESCE_WINDOW_MS;
    for (const [userId, entry] of recentHydrations) {
      if (entry.hydratedAt < cutoff) recentHydrations.delete(userId);
    }
  }

  function reportMetrics() {
    pruneRecentHydrations();
    metricSet(metrics.wsBootstrapHydrationQueueDepth, pendingQueue.length);
    metricSet(metrics.wsBootstrapHydrationActive, activeHydrations);
    metricSet(metrics.wsBootstrapHydrationCooldownActive, recentHydrations.size);
  }

  function isLiveFanoutActive(): boolean {
    if (liveFanoutPendingCount <= 0) return false;
    // Consider live fanout active if signaled within the last 100ms
    return Date.now() - liveFanoutSignalAt < 100;
  }

  async function waitForLiveFanoutQuiet(): Promise<void> {
    while (PROTECTION_ENABLED && isLiveFanoutActive()) {
      metricInc(metrics.wsBootstrapPausedForLiveFanoutTotal);
      await sleep(LIVE_FANOUT_YIELD_MS);
    }
  }

  // ── Drain loop ──────────────────────────────────────────────────────────────
  async function drainQueue(
    hydrateFn: (ws: any, channels: string[]) => Promise<HydrationResult | void>,
  ): Promise<void> {
    if (draining) return;
    draining = true;

    while (pendingQueue.length > 0) {
      await waitForLiveFanoutQuiet();

      // Check concurrency cap
      if (activeHydrations >= HYDRATION_MAX_CONCURRENT) {
        // Wait for a slot to open
        await sleep(HYDRATION_BATCH_INTERVAL_MS);
        continue;
      }

      const item = pendingQueue.shift();
      if (!item) break;

      // Check if socket is still open
      if (item.ws.readyState !== 1) {
        metricInc(metrics.wsBootstrapHydrationSkippedTotal, { reason: 'closed_socket' });
        item.resolve({ status: 'skipped', reason: 'closed_socket' });
        inFlightByUser.delete(item.userId);
        reportMetrics();
        continue;
      }

      const delayMs = Date.now() - item.enqueuedAt;
      metricObserve(metrics.wsBootstrapHydrationDelayMs, delayMs);

      activeHydrations += 1;
      reportMetrics();

      // Add jittered delay between hydrations to smooth burst
      const jitter = PROTECTION_ENABLED ? jitterMs() : 0;
      if (jitter > 0) {
        await sleep(jitter);
      }

      // Run hydration in background (don't await to allow concurrency)
      const hydrationPromise = Promise.resolve()
        .then(() => hydrateFn(item.ws, item.channels))
        .then((result) => {
          const resolved = result || { status: 'hydrated' as const };
          if (resolved.status === 'hydrated') {
            recentHydrations.set(item.userId, {
              hydratedAt: Date.now(),
              fingerprint: item.fingerprint,
            });
          }
          item.resolve(resolved);
          return resolved;
        })
        .catch((err: Error) => {
          item.reject(err);
          throw err;
        })
        .finally(() => {
          activeHydrations = Math.max(0, activeHydrations - 1);
          inFlightByUser.delete(item.userId);
          reportMetrics();
          // Continue draining
          if (pendingQueue.length > 0) {
            setImmediate(() => drainQueue(hydrateFn));
          }
        });
      inFlightByUser.set(item.userId, hydrationPromise);
    }

    draining = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a hydration job. If the same user was hydrated recently within the
   * coalesce window, skip duplicate work.
   */
  function enqueueHydration(
    ws: any,
    userId: string,
    channels: string[],
    hydrateFn: (ws: any, channels: string[]) => Promise<HydrationResult | void>,
  ): Promise<HydrationResult> {
    if (!PROTECTION_ENABLED) {
      return Promise.resolve(hydrateFn(ws, channels)).then((result) => result || { status: 'hydrated' });
    }

    const fingerprint = channelFingerprint(channels);
    const nowMs = Date.now();
    pruneRecentHydrations(nowMs);

    const recent = recentHydrations.get(userId);
    if (
      recent
      && recent.fingerprint === fingerprint
      && nowMs - recent.hydratedAt < COALESCE_WINDOW_MS
    ) {
      metricInc(metrics.wsBootstrapCoalescedTotal, { reason: 'recent_hydration' });
      metricInc(metrics.wsBootstrapHydrationSkippedTotal, { reason: 'recent_hydration' });
      reportMetrics();
      return Promise.resolve({ status: 'skipped', reason: 'recent_hydration' });
    }

    const inFlight = inFlightByUser.get(userId);
    if (inFlight) {
      metricInc(metrics.wsBootstrapCoalescedTotal, { reason: 'duplicate_inflight' });
      metricInc(metrics.wsBootstrapHydrationSkippedTotal, { reason: 'duplicate_inflight' });
      return inFlight.then(() => ({ status: 'skipped', reason: 'duplicate_inflight' }));
    }

    const queuedPromise = new Promise<HydrationResult>((resolve, reject) => {
      pendingQueue.push({
        ws,
        userId,
        channels,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        fingerprint,
      });
      metricInc(metrics.wsBootstrapHydrationDeferredTotal, { reason: 'scheduled' });
      reportMetrics();
      drainQueue(hydrateFn);
    });
    inFlightByUser.set(userId, queuedPromise);
    return queuedPromise;
  }

  /**
   * Called when live fanout work is about to run. Signals the scheduler to
   * yield bootstrap hydration in favor of live message delivery.
   */
  function signalLiveFanoutPending(): void {
    liveFanoutPendingCount += 1;
    liveFanoutSignalAt = Date.now();
    metricInc(metrics.wsLiveFanoutStarvationGuardTotal);
  }

  function releaseLiveFanoutPending(): void {
    liveFanoutPendingCount = Math.max(0, liveFanoutPendingCount - 1);
  }

  /**
   * Check if a user's bootstrap hydration was recently completed (for coalescing).
   */
  function wasUserRecentlyHydrated(userId: string): boolean {
    pruneRecentHydrations();
    return recentHydrations.has(userId);
  }

  /**
   * Mark a user as hydrated (for coalescing when hydration runs outside the scheduler).
   */
  function markUserHydrated(userId: string): void {
    recentHydrations.set(userId, { hydratedAt: Date.now(), fingerprint: 'manual' });
    reportMetrics();
  }

  function getQueueDepth(): number {
    return pendingQueue.length;
  }

  function getActiveHydrations(): number {
    return activeHydrations;
  }

  function resetForTests(): void {
    pendingQueue.length = 0;
    activeHydrations = 0;
    inFlightByUser.clear();
    recentHydrations.clear();
    liveFanoutPendingCount = 0;
    liveFanoutSignalAt = 0;
    draining = false;
  }

  return {
    enqueueHydration,
    signalLiveFanoutPending,
    releaseLiveFanoutPending,
    waitForLiveFanoutQuiet,
    wasUserRecentlyHydrated,
    markUserHydrated,
    getQueueDepth,
    getActiveHydrations,
    resetForTests,
    isProtectionEnabled: () => PROTECTION_ENABLED,
  };
}

module.exports = {
  createBootstrapHydrationScheduler,
  HYDRATION_MAX_CONCURRENT,
  COALESCE_WINDOW_MS,
};
