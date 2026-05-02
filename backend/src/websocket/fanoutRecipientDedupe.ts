/**
 * Per-message, per-recipient deduplication across fanout paths.
 *
 * When a message is fanned out through multiple paths (channel topic,
 * user topics, recent-connect bridge, stale-map recovery), the same
 * recipient may appear in multiple paths. This module ensures each
 * recipient is sent the message exactly once per message event.
 *
 * Uses a short-lived Map keyed by `${eventName}:${messageId}:${userId}:${connectionId}`
 * with TTL eviction. This is process-local (each node dedupes independently).
 */

type MetricInc = (labels?: Record<string, string>, value?: number) => void;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 100_000;

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

const DEDUPE_TTL_MS = parseIntEnv('WS_FANOUT_RECIPIENT_DEDUPE_TTL_MS', DEFAULT_TTL_MS, 5_000, 120_000);
const DEDUPE_MAX_ENTRIES = parseIntEnv('WS_FANOUT_RECIPIENT_DEDUPE_MAX_ENTRIES', DEFAULT_MAX_ENTRIES, 10_000, 1_000_000);

function createFanoutRecipientDedupe(metrics: {
  wsRecipientDedupeTotal?: any;
  wsRecipientDuplicateCandidatesTotal?: any;
}) {
  // Map: dedupeKey → timestamp
  const seen = new Map<string, number>();

  function prune(nowMs: number): void {
    const cutoff = nowMs - DEDUPE_TTL_MS;
    // Evict expired entries (iterate from oldest since Map preserves insertion order)
    for (const [key, ts] of seen) {
      if (ts >= cutoff) break;
      seen.delete(key);
    }
    // Hard cap
    if (seen.size > DEDUPE_MAX_ENTRIES) {
      const excess = seen.size - DEDUPE_MAX_ENTRIES;
      let i = 0;
      for (const key of seen.keys()) {
        if (i >= excess) break;
        seen.delete(key);
        i += 1;
      }
    }
  }

  /**
   * Build a dedupe key for a message event + recipient pair.
   */
  function buildKey(messageId: string, userId: string, eventName: string, connectionId: string): string {
    return `${eventName}:${messageId}:${userId}:${connectionId}`;
  }

  function hasSeenRecipient(messageId: string, userId: string, eventName = 'message:created', connectionId = 'user'): boolean {
    if (!messageId || !userId || !eventName || !connectionId) return false;
    prune(Date.now());
    return seen.has(buildKey(messageId, userId, eventName, connectionId));
  }

  function markRecipient(messageId: string, userId: string, path: string, eventName = 'message:created', connectionId = 'user'): void {
    if (!messageId || !userId || !eventName || !connectionId) return;
    const nowMs = Date.now();
    seen.set(buildKey(messageId, userId, eventName, connectionId), nowMs);
    metrics.wsRecipientDedupeTotal?.inc({ path });
    prune(nowMs);
  }

  function markDuplicateRecipient(messageId: string, userId: string, path: string): void {
    if (!messageId || !userId) return;
    metrics.wsRecipientDuplicateCandidatesTotal?.inc({ path });
  }

  /**
   * Check if this message has already been delivered to this recipient.
   * If not, mark it as seen and return false (should deliver).
   * If already seen, return true (should skip).
   */
  function shouldSkipRecipient(messageId: string, userId: string, path: string, eventName = 'message:created', connectionId = 'user'): boolean {
    if (!messageId || !userId || !eventName || !connectionId) return false;
    if (hasSeenRecipient(messageId, userId, eventName, connectionId)) {
      markDuplicateRecipient(messageId, userId, path);
      return true;
    }
    markRecipient(messageId, userId, path, eventName, connectionId);
    return false;
  }

  /**
   * Extract messageId from a parsed payload.
   */
  function extractMessageId(parsed: any): string | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const data = parsed.data;
    if (!data || typeof data !== 'object') return null;
    const id = data.id || data.messageId || data.message_id;
    return typeof id === 'string' ? id : null;
  }

  function resetForTests(): void {
    seen.clear();
  }

  function getSize(): number {
    return seen.size;
  }

  return {
    shouldSkipRecipient,
    hasSeenRecipient,
    markRecipient,
    markDuplicateRecipient,
    extractMessageId,
    resetForTests,
    getSize,
  };
}

module.exports = {
  createFanoutRecipientDedupe,
};
