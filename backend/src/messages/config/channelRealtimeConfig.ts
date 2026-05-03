const { resolvedWsRuntimeConfig } = require('../../websocket/profile');

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

function envInt(
  name: string,
  defaultValue: number,
  { min, max }: { min?: number; max?: number } = {},
): number {
  const parsed = Number(process.env[name] ?? String(defaultValue));
  if (!Number.isFinite(parsed)) return defaultValue;
  let value = Math.floor(parsed);
  if (min != null) value = Math.max(min, value);
  if (max != null) value = Math.min(max, value);
  return value;
}

const rawUserFanoutTargetsCacheTtl = Number(
  process.env.CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS || '180',
);

const channelRealtimeConfig = Object.freeze({
  CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS:
    Number.isFinite(rawUserFanoutTargetsCacheTtl) && rawUserFanoutTargetsCacheTtl > 0
      ? Math.floor(rawUserFanoutTargetsCacheTtl)
      : 180,
  RECENT_CONNECT_TARGET_CACHE_MS: envInt('RECENT_CONNECT_TARGET_CACHE_MS', 1500, { min: 0 }),
  ACTIVE_CONNECTED_TARGET_BATCH: 500,
  CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK:
    resolvedWsRuntimeConfig().recentConnectIncludeConnectedFallback,
  CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX: envInt(
    'CHANNEL_MESSAGE_RECENT_CONNECT_FALLBACK_PROBE_MAX',
    512,
    { min: 64, max: 5000 },
  ),
  CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX: envInt(
    'CHANNEL_MESSAGE_IMMEDIATE_RECENT_BRIDGE_MAX',
    256,
    { min: 50, max: 1000 },
  ),
  CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST: envBool('CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST', true),
  CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH: envBool('CHANNEL_MESSAGE_SKIP_USERFEED_PUBLISH', false),
  MESSAGE_USER_FANOUT_HTTP_BLOCKING: envBool('MESSAGE_USER_FANOUT_HTTP_BLOCKING', true),
  CHANNEL_MESSAGE_USER_FANOUT_MAX: envInt('CHANNEL_MESSAGE_USER_FANOUT_MAX', 10000, {
    min: 1,
    max: 10000,
  }),
});

function channelMessageUserFanoutEnabled() {
  return envBool('CHANNEL_MESSAGE_USER_FANOUT', true);
}

module.exports = { channelRealtimeConfig, channelMessageUserFanoutEnabled };

