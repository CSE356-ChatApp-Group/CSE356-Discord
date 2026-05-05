function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const IDLE_TTL_SECONDS = 60;
const CONNECTION_ALIVE_TTL_SECONDS = 120;
const PRESENCE_SWEEPER_MS = envInt('PRESENCE_SWEEPER_MS', 15_000);

const WS_BACKPRESSURE_DROP_BYTES = envInt('WS_BACKPRESSURE_DROP_BYTES', 64 * 1024);
const WS_BACKPRESSURE_KILL_BYTES = envInt('WS_BACKPRESSURE_KILL_BYTES', 2 * 1024 * 1024);
const WS_OUTBOUND_QUEUE_MAX_MESSAGE = envInt('WS_OUTBOUND_QUEUE_MAX_MESSAGE', 512);
const WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT = envInt('WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT', 128);
const WS_OUTBOUND_DRAIN_BATCH = envInt('WS_OUTBOUND_DRAIN_BATCH', 32);
const WS_REPLAY_OUTBOUND_YIELD_EVERY = (() => {
  const raw = envInt('WS_REPLAY_OUTBOUND_YIELD_EVERY', 48);
  if (!Number.isFinite(raw) || raw < 1) return 48;
  return Math.min(512, Math.max(8, Math.floor(raw)));
})();
const WS_OUTBOUND_MESSAGE_WAITERS_MAX = Math.max(
  64,
  Math.min(65_536, envInt('WS_OUTBOUND_MESSAGE_WAITERS_MAX', 4_096) || 4_096),
);

const PRESENCE_SWEEPER_DEBOUNCE_MS = 5_000;
const PRESENCE_DISCONNECT_DEBOUNCE_MS = 1_000;

const ACL_CACHE_TTL_MS = 30_000;
const _aclRedisTtlSecs = envNumber('WS_ACL_REDIS_TTL_SECS', Math.ceil(ACL_CACHE_TTL_MS / 1000));
const WS_ACL_REDIS_TTL_SECS =
  Number.isFinite(_aclRedisTtlSecs) && _aclRedisTtlSecs > 0
    ? Math.floor(_aclRedisTtlSecs)
    : 30;
const rawAclCacheMaxEntries = envNumber('WS_ACL_CACHE_MAX_ENTRIES', 20_000);
const ACL_CACHE_MAX_ENTRIES =
  Number.isFinite(rawAclCacheMaxEntries) && rawAclCacheMaxEntries > 0
    ? Math.floor(rawAclCacheMaxEntries)
    : 20_000;
const rawBootstrapBatchSize = envNumber('WS_BOOTSTRAP_BATCH_SIZE', 96);
const WS_BOOTSTRAP_BATCH_SIZE =
  Number.isFinite(rawBootstrapBatchSize) && rawBootstrapBatchSize > 0
    ? Math.floor(rawBootstrapBatchSize)
    : 96;
const rawRecentDisconnectTtlSeconds = envNumber('WS_RECENT_DISCONNECT_TTL_SECONDS', 3_600);
const WS_RECENT_DISCONNECT_TTL_SECONDS =
  Number.isFinite(rawRecentDisconnectTtlSeconds) && rawRecentDisconnectTtlSeconds > 0
    ? Math.floor(rawRecentDisconnectTtlSeconds)
    : 3600;
const rawHeartbeatIntervalMs = envNumber('WS_HEARTBEAT_INTERVAL_MS', 20_000);
const WS_HEARTBEAT_INTERVAL_MS =
  Number.isFinite(rawHeartbeatIntervalMs) && rawHeartbeatIntervalMs >= 5_000
    ? Math.floor(rawHeartbeatIntervalMs)
    : 20_000;
const rawAppKeepaliveIntervalMs = envNumber('WS_APP_KEEPALIVE_INTERVAL_MS', 0);
const WS_APP_KEEPALIVE_INTERVAL_MS =
  Number.isFinite(rawAppKeepaliveIntervalMs) && rawAppKeepaliveIntervalMs >= 5_000
    ? Math.floor(rawAppKeepaliveIntervalMs)
    : 0;
const WS_APP_KEEPALIVE_FRAME = JSON.stringify({ event: 'keepalive' });
const rawShutdownCloseGraceMs = envNumber('WS_SHUTDOWN_CLOSE_GRACE_MS', 2_000);
const WS_SHUTDOWN_CLOSE_GRACE_MS =
  Number.isFinite(rawShutdownCloseGraceMs) && rawShutdownCloseGraceMs >= 250
    ? Math.min(10_000, Math.floor(rawShutdownCloseGraceMs))
    : 2_000;
const WS_SERVICE_RESTART_CLOSE_CODE = 1012;
const WS_SERVICE_RESTART_CLOSE_REASON = 'service_restart';
const rawReplayUserCooldownMs = envNumber('WS_REPLAY_USER_COOLDOWN_MS', 3_000);
const WS_REPLAY_USER_COOLDOWN_MS =
  Number.isFinite(rawReplayUserCooldownMs) && rawReplayUserCooldownMs >= 500
    ? Math.min(10_000, Math.floor(rawReplayUserCooldownMs))
    : 3000;
const _wsHotLogSampleRate = envNumber('WS_HOT_LOG_SAMPLE_RATE', 0);
const WS_HOT_LOG_SAMPLE_RATE =
  Number.isFinite(_wsHotLogSampleRate) && _wsHotLogSampleRate >= 0
    ? Math.min(1, Math.max(0, _wsHotLogSampleRate))
    : 0;

const WS_BOOTSTRAP_CACHE_TTL_SECONDS = envInt('WS_BOOTSTRAP_CACHE_TTL_SECONDS', 180);
const WS_BOOTSTRAP_INGRESS_TTL_SECONDS = 3;
const rawBootstrapIngressJitterMs = envNumber('WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS', 200);
const WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS =
  Number.isFinite(rawBootstrapIngressJitterMs) && rawBootstrapIngressJitterMs >= 0
    ? Math.min(500, Math.floor(rawBootstrapIngressJitterMs))
    : 200;
const rawBootstrapDbConcurrencyCap = envNumber('WS_BOOTSTRAP_DB_MAX_IN_FLIGHT', 50);
const WS_BOOTSTRAP_DB_MAX_IN_FLIGHT =
  Number.isFinite(rawBootstrapDbConcurrencyCap) && rawBootstrapDbConcurrencyCap > 0
    ? Math.min(200, Math.floor(rawBootstrapDbConcurrencyCap))
    : 50;
const rawBootstrapDbConcurrencyWaitMs = envNumber('WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS', 300);
const WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS =
  Number.isFinite(rawBootstrapDbConcurrencyWaitMs) && rawBootstrapDbConcurrencyWaitMs >= 0
    ? Math.min(2000, Math.floor(rawBootstrapDbConcurrencyWaitMs))
    : 300;
const rawRedisSubscriptionReleaseGraceMs = envNumber('WS_REDIS_SUBSCRIPTION_RELEASE_GRACE_MS', 0);
const WS_REDIS_SUBSCRIPTION_RELEASE_GRACE_MS =
  Number.isFinite(rawRedisSubscriptionReleaseGraceMs) && rawRedisSubscriptionReleaseGraceMs >= 0
    ? Math.min(300000, Math.floor(rawRedisSubscriptionReleaseGraceMs))
    : 0;

// Number of consecutive missed heartbeat pings before a socket is terminated.
// Default 2 means a socket must miss two back-to-back pings (≥ 2× interval) to be killed,
// giving transient network hiccups and backgrounded mobile tabs a survival window.
const rawHeartbeatMissedPings = envNumber('WS_HEARTBEAT_MISSED_PINGS_BEFORE_KILL', 2);
const WS_HEARTBEAT_MISSED_PINGS_BEFORE_KILL =
  Number.isFinite(rawHeartbeatMissedPings) && rawHeartbeatMissedPings >= 1
    ? Math.min(5, Math.floor(rawHeartbeatMissedPings))
    : 2;

module.exports = {
  IDLE_TTL_SECONDS,
  CONNECTION_ALIVE_TTL_SECONDS,
  PRESENCE_SWEEPER_MS,
  WS_BACKPRESSURE_DROP_BYTES,
  WS_BACKPRESSURE_KILL_BYTES,
  WS_OUTBOUND_QUEUE_MAX_MESSAGE,
  WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT,
  WS_OUTBOUND_DRAIN_BATCH,
  WS_REPLAY_OUTBOUND_YIELD_EVERY,
  WS_OUTBOUND_MESSAGE_WAITERS_MAX,
  PRESENCE_SWEEPER_DEBOUNCE_MS,
  PRESENCE_DISCONNECT_DEBOUNCE_MS,
  ACL_CACHE_TTL_MS,
  WS_ACL_REDIS_TTL_SECS,
  ACL_CACHE_MAX_ENTRIES,
  WS_BOOTSTRAP_BATCH_SIZE,
  WS_RECENT_DISCONNECT_TTL_SECONDS,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_APP_KEEPALIVE_INTERVAL_MS,
  WS_APP_KEEPALIVE_FRAME,
  WS_SHUTDOWN_CLOSE_GRACE_MS,
  WS_SERVICE_RESTART_CLOSE_CODE,
  WS_SERVICE_RESTART_CLOSE_REASON,
  WS_REPLAY_USER_COOLDOWN_MS,
  WS_HOT_LOG_SAMPLE_RATE,
  WS_BOOTSTRAP_CACHE_TTL_SECONDS,
  WS_BOOTSTRAP_INGRESS_TTL_SECONDS,
  WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS,
  WS_BOOTSTRAP_DB_MAX_IN_FLIGHT,
  WS_BOOTSTRAP_DB_CONCURRENCY_WAIT_MS,
  WS_REDIS_SUBSCRIPTION_RELEASE_GRACE_MS,
  WS_HEARTBEAT_MISSED_PINGS_BEFORE_KILL,
};
