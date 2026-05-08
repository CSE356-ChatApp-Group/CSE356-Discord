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

function envInt(name: string, defaultValue: number, { min }: { min?: number } = {}): number {
  const parsed = Number(process.env[name] ?? String(defaultValue));
  if (!Number.isFinite(parsed)) return defaultValue;
  let value = Math.floor(parsed);
  if (min != null) value = Math.max(min, value);
  return value;
}

const conversationFanoutConfig = Object.freeze({
  CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS: envInt(
    'CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS',
    120,
    { min: 1 },
  ),
  CONVERSATION_FANOUT_TARGETS_CACHE_WARMUP_MISSES: envInt(
    'CONVERSATION_FANOUT_TARGETS_CACHE_WARMUP_MISSES',
    2,
    { min: 1 },
  ),
  CONVERSATION_FANOUT_TARGETS_CACHE_WARMUP_WINDOW_MS: envInt(
    'CONVERSATION_FANOUT_TARGETS_CACHE_WARMUP_WINDOW_MS',
    30000,
    { min: 1000 },
  ),
  DM_FANOUT_TIMING_LOG: envBool('DM_FANOUT_TIMING_LOG', false)
    || String(process.env.DM_FANOUT_TIMING_LOG || '').toLowerCase() === 'all',
  DM_FANOUT_TIMING_LOG_MIN_MS: envInt('DM_FANOUT_TIMING_LOG_MIN_MS', 50, { min: 0 }),
});

module.exports = { conversationFanoutConfig };

