type WsProfile = 'default' | 'generated-client';
type WsAutoSubscribeMode = 'messages' | 'user_only' | 'full';
type ChannelUserFanoutMode = 'all' | 'recent_connect';
type ResolvedWsRuntimeConfig = {
  profile: WsProfile;
  autoSubscribeMode: WsAutoSubscribeMode;
  channelUserFanoutMode: ChannelUserFanoutMode;
  recentConnectIncludeConnectedFallback: boolean;
};

function normalizedProfileName(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function wsProfile(): WsProfile {
  const normalized = normalizedProfileName(process.env.WS_PROFILE || '');
  if (normalized === 'generated-client') return 'generated-client';
  return 'default';
}

function defaultWsAutoSubscribeMode(): 'messages' {
  // Generated-client and default profiles both prefer server-managed message topics.
  return 'messages';
}

function defaultChannelUserFanoutMode(): ChannelUserFanoutMode {
  // Generated-client profile favors reduced duplicate user-topic fanout.
  return wsProfile() === 'generated-client' ? 'recent_connect' : 'all';
}

function defaultRecentConnectIncludeConnectedFallback(): boolean {
  // With generated-client profile + messages autosubscribe, zset + marker fallback
  // is usually sufficient while connected-users probing adds Redis load.
  if (wsProfile() === 'generated-client') return false;
  return true;
}

function resolveWsAutoSubscribeMode(
  rawValue = process.env.WS_AUTO_SUBSCRIBE_MODE,
): WsAutoSubscribeMode {
  const normalized = String(rawValue || defaultWsAutoSubscribeMode())
    .trim()
    .toLowerCase();
  if (normalized === 'user_only' || normalized === 'full') return normalized;
  return 'messages';
}

function resolveChannelUserFanoutMode(
  rawValue = process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE,
): ChannelUserFanoutMode {
  const normalized = String(rawValue || defaultChannelUserFanoutMode())
    .trim()
    .toLowerCase();
  return normalized === 'recent_connect' ? 'recent_connect' : 'all';
}

function resolveRecentConnectIncludeConnectedFallback(
  rawValue = process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK,
  autoSubscribeMode: WsAutoSubscribeMode = resolveWsAutoSubscribeMode(),
): boolean {
  if (rawValue != null) {
    const normalized = String(rawValue).trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
    return defaultRecentConnectIncludeConnectedFallback();
  }
  if (autoSubscribeMode === 'messages') {
    return defaultRecentConnectIncludeConnectedFallback();
  }
  return true;
}

function getResolvedWsRuntimeConfig(): ResolvedWsRuntimeConfig {
  const profile = wsProfile();
  const autoSubscribeMode = resolveWsAutoSubscribeMode();
  const channelUserFanoutMode = resolveChannelUserFanoutMode();
  const recentConnectIncludeConnectedFallback = resolveRecentConnectIncludeConnectedFallback(
    process.env.CHANNEL_MESSAGE_RECENT_CONNECT_INCLUDE_CONNECTED_FALLBACK,
    autoSubscribeMode,
  );
  return {
    profile,
    autoSubscribeMode,
    channelUserFanoutMode,
    recentConnectIncludeConnectedFallback,
  };
}

const RESOLVED_WS_RUNTIME_CONFIG: Readonly<ResolvedWsRuntimeConfig> = Object.freeze(
  getResolvedWsRuntimeConfig(),
);

function resolvedWsRuntimeConfig(): Readonly<ResolvedWsRuntimeConfig> {
  return RESOLVED_WS_RUNTIME_CONFIG;
}

module.exports = {
  wsProfile,
  defaultWsAutoSubscribeMode,
  defaultChannelUserFanoutMode,
  defaultRecentConnectIncludeConnectedFallback,
  resolveWsAutoSubscribeMode,
  resolveChannelUserFanoutMode,
  resolveRecentConnectIncludeConnectedFallback,
  getResolvedWsRuntimeConfig,
  resolvedWsRuntimeConfig,
};

