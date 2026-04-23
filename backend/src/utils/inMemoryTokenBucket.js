'use strict';

/**
 * Per-key token bucket (in-process only). Bounded map size; stale keys evicted opportunistically.
 */

const DEFAULT_MAX_KEYS = 50_000;

function createTokenBucket({
  refillPerSecond,
  burst,
  maxKeys = DEFAULT_MAX_KEYS,
  getScale = () => 1,
} = {}) {
  const rate = Number(refillPerSecond);
  const cap = Math.max(1, Math.floor(Number(burst) || 1));
  const baseRefill = Number.isFinite(rate) && rate > 0 ? rate : 1;

  /** @type {Map<string, { tokens: number, updatedAt: number }>} */
  const buckets = new Map();

  function pruneIfNeeded() {
    if (buckets.size <= maxKeys) return;
    const drop = Math.ceil(maxKeys * 0.1);
    let i = 0;
    for (const k of buckets.keys()) {
      buckets.delete(k);
      i += 1;
      if (i >= drop) break;
    }
  }

  /**
   * @param {string} key
   * @param {number} [now]
   * @returns {boolean}
   */
  function take(key, now = Date.now()) {
    if (!key) return false;
    pruneIfNeeded();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: cap, updatedAt: now };
      buckets.set(key, b);
    }
    const scaleRaw = typeof getScale === 'function' ? Number(getScale()) : 1;
    const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 && scaleRaw <= 1 ? scaleRaw : 1;
    const refill = baseRefill * scale;
    const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
    b.tokens = Math.min(cap, b.tokens + elapsedSec * refill);
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  return { take };
}

module.exports = { createTokenBucket };
