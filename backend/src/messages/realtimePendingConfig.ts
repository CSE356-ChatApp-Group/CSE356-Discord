function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function envInt(name: string, defaultValue: number): number {
  const parsed = Number(process.env[name] ?? String(defaultValue));
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.floor(parsed);
}

const rawPendingTtlSeconds = envInt('WS_REPLAY_PENDING_TTL_SECONDS', 180);
const rawPendingDrainLimit = envInt('WS_REPLAY_PENDING_DRAIN_LIMIT', 300);
const rawPendingUserCap = envInt('WS_REPLAY_PENDING_USER_MAX_ZSET', 400);
const rawPendingMemoryGuardPct = envInt('WS_REPLAY_PENDING_MEMORY_GUARD_PCT', 85);

const realtimePendingConfig = Object.freeze({
  WS_REPLAY_PENDING_TTL_SECONDS:
    rawPendingTtlSeconds >= 60 && rawPendingTtlSeconds <= 300 ? rawPendingTtlSeconds : 180,
  WS_REPLAY_PENDING_DRAIN_LIMIT:
    rawPendingDrainLimit > 0 ? Math.min(2000, Math.max(10, rawPendingDrainLimit)) : 300,
  WS_REPLAY_PENDING_USER_MAX_ZSET:
    rawPendingUserCap > 0 ? Math.min(5000, Math.max(50, rawPendingUserCap)) : 400,
  WS_REPLAY_PENDING_MEMORY_GUARD_PCT:
    rawPendingMemoryGuardPct >= 50 ? Math.min(98, Math.max(50, rawPendingMemoryGuardPct)) : 85,
  WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED: envBool('WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED', true),
  WS_REPLAY_PENDING_MEMORY_GUARD_CACHE_MS: 2000,
  WS_REPLAY_PENDING_ONLY_ACTIVE: envBool('WS_REPLAY_PENDING_ONLY_ACTIVE', true),
  WS_REPLAY_PENDING_LEGACY_ALL: envBool('WS_REPLAY_PENDING_LEGACY_ALL', false),
  WS_PENDING_ELIGIBLE_LEGACY_FALLBACK: envBool('WS_PENDING_ELIGIBLE_LEGACY_FALLBACK', true),
  WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK: envBool(
    'WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK',
    true,
  ),
  REDIS_PENDING_CLASSIFY_BATCH: 48,
  PENDING_MIN_MARKER: '__pendingMin',
});

module.exports = { realtimePendingConfig };

