'use strict';

const redis = require('../db/redis');
const logger = require('../utils/logger');
const { loadHydratedMessageById } = require('./messageHydrate');
const { wrapFanoutPayload } = require('./realtimePayload');
const {
  wsRecentConnectKey,
  wsReplayPendingEligibilityKey,
  WS_REPLAY_RECENT_USER_WINDOW_SECONDS,
} = require('../websocket/recentConnect');
const {
  wsPendingReplayUserTrimmedTotal,
  wsPendingUserZsetSize,
  wsPendingReplayGuardTotal,
  pendingReplayRecipientTotal,
  pendingReplayEntriesPerMessage,
  offlinePendingSkippedTotal,
} = require('../utils/metrics');

const rawPendingTtlSeconds = Number(process.env.WS_REPLAY_PENDING_TTL_SECONDS || '180');
const WS_REPLAY_PENDING_TTL_SECONDS =
  Number.isFinite(rawPendingTtlSeconds) && rawPendingTtlSeconds >= 60 && rawPendingTtlSeconds <= 300
    ? Math.floor(rawPendingTtlSeconds)
    : 180;

const rawPendingDrainLimit = Number(process.env.WS_REPLAY_PENDING_DRAIN_LIMIT || '300');
const WS_REPLAY_PENDING_DRAIN_LIMIT =
  Number.isFinite(rawPendingDrainLimit) && rawPendingDrainLimit > 0
    ? Math.min(2000, Math.max(10, Math.floor(rawPendingDrainLimit)))
    : 300;

const rawPendingUserCap = Number(process.env.WS_REPLAY_PENDING_USER_MAX_ZSET || '400');
const WS_REPLAY_PENDING_USER_MAX_ZSET =
  Number.isFinite(rawPendingUserCap) && rawPendingUserCap > 0
    ? Math.min(5000, Math.max(50, Math.floor(rawPendingUserCap)))
    : 400;

const rawPendingMemoryGuardPct = Number(process.env.WS_REPLAY_PENDING_MEMORY_GUARD_PCT || '85');
const WS_REPLAY_PENDING_MEMORY_GUARD_PCT =
  Number.isFinite(rawPendingMemoryGuardPct) && rawPendingMemoryGuardPct >= 50
    ? Math.min(98, Math.max(50, Math.floor(rawPendingMemoryGuardPct)))
    : 85;

const WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED =
  String(process.env.WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED || 'true').toLowerCase() !== 'false';
const WS_REPLAY_PENDING_MEMORY_GUARD_CACHE_MS = 2000;

/** When true (default), only enqueue `ws:pending:user:*` for users with an active WS or a recent session marker. */
const WS_REPLAY_PENDING_ONLY_ACTIVE =
  String(process.env.WS_REPLAY_PENDING_ONLY_ACTIVE ?? 'true').toLowerCase() !== 'false';

/** Emergency: enqueue pending pointers for every fanout target (pre-redesign behavior). */
const WS_REPLAY_PENDING_LEGACY_ALL =
  String(process.env.WS_REPLAY_PENDING_LEGACY_ALL || 'false').toLowerCase() === 'true';

const PENDING_MIN_MARKER = '__pendingMin';
let pendingGuardCachedUntilMs = 0;
let pendingGuardCachedShouldSkip = false;
let pendingGuardLastWarnAtMs = 0;

const REDIS_PENDING_CLASSIFY_BATCH = 48;

function pendingUserKey(userId: string) {
  return `ws:pending:user:${userId}`;
}

function pendingMessageKey(messageId: string) {
  return `ws:pending:message:${messageId}`;
}

/** Same pattern as `connectionSetKey` in `websocket/server.ts` / presence (cluster-wide WS registry). */
function userConnectionSetKey(userId: string) {
  return `user:${userId}:connections`;
}

function isRedisOperational() {
  return ['wait', 'connecting', 'connect', 'ready', 'reconnecting'].includes(redis.status);
}

function extractMessageId(payload: any): string | null {
  const messageId = payload?.data?.id || payload?.data?.messageId || payload?.data?.message_id;
  return typeof messageId === 'string' && messageId ? messageId : null;
}

function normalizeUserIds(targets: string[]) {
  return [...new Set(
    (Array.isArray(targets) ? targets : [])
      .map((target) => typeof target === 'string' ? target : '')
      .map((target) => target.startsWith('user:') ? target.slice(5) : target)
      .filter((value) => value.length > 0),
  )];
}

function pendingReplayFilterEnabled() {
  return WS_REPLAY_PENDING_ONLY_ACTIVE && !WS_REPLAY_PENDING_LEGACY_ALL;
}

/**
 * Returns user ids that should receive `ws:pending:user:*` zadd for this message.
 * Offline users still get history from Postgres on reconnect; DB replay covers gaps.
 */
async function filterUsersEligibleForPendingReplay(userIds: string[]): Promise<{
  eligible: string[];
  perClass: { connected: number; recent: number; offlineSkipped: number };
}> {
  const perClass = { connected: 0, recent: 0, offlineSkipped: 0 };
  if (!userIds.length) {
    return { eligible: [], perClass };
  }

  const eligible: string[] = [];
  const useReplayKey = WS_REPLAY_RECENT_USER_WINDOW_SECONDS > 0;

  for (let offset = 0; offset < userIds.length; offset += REDIS_PENDING_CLASSIFY_BATCH) {
    const slice = userIds.slice(offset, offset + REDIS_PENDING_CLASSIFY_BATCH);
    const pipe = redis.pipeline();
    for (const uid of slice) {
      pipe.exists(wsRecentConnectKey(uid));
      if (useReplayKey) pipe.exists(wsReplayPendingEligibilityKey(uid));
      pipe.scard(userConnectionSetKey(uid));
    }
    const results = await pipe.exec();
    let idx = 0;
    for (let i = 0; i < slice.length; i += 1) {
      const uid = slice[i];
      const exRecent = Number(results[idx++]?.[1] || 0) === 1;
      const exReplay = useReplayKey ? Number(results[idx++]?.[1] || 0) === 1 : false;
      const connCount = Number(results[idx++]?.[1] || 0) || 0;

      const hasRecentMarker = exRecent || exReplay;
      if (connCount > 0) {
        eligible.push(uid);
        perClass.connected += 1;
      } else if (hasRecentMarker) {
        eligible.push(uid);
        perClass.recent += 1;
      } else {
        perClass.offlineSkipped += 1;
      }
    }
  }

  return { eligible, perClass };
}

/** Shrink Redis footprint: store ids + event only; hydrate from Postgres on drain. */
function buildPendingRedisPayload(payload: Record<string, unknown>, messageId: string) {
  const data = payload?.data as Record<string, unknown> | undefined;
  const event = typeof payload?.event === 'string' ? payload.event : 'message:created';
  return {
    [PENDING_MIN_MARKER]: true,
    event,
    id: messageId,
    ch: data?.channel_id ?? data?.channelId ?? null,
    cv: data?.conversation_id ?? data?.conversationId ?? null,
  };
}

function isLegacyFullPendingPayload(parsed: Record<string, unknown>) {
  return !parsed[PENDING_MIN_MARKER] && typeof parsed.event === 'string' && parsed.data !== undefined;
}

async function hydratePendingPayload(parsed: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = typeof parsed.id === 'string' ? parsed.id : null;
  if (!id) return null;
  const event = typeof parsed.event === 'string' ? parsed.event : 'message:created';
  const row = await loadHydratedMessageById(id);
  if (!row) return null;
  return wrapFanoutPayload(event, row) as Record<string, unknown>;
}

async function enqueuePendingMessageForUsers(targets: string[], payload: Record<string, unknown>) {
  if (!isRedisOperational()) return;
  const messageId = extractMessageId(payload);
  if (!messageId) return;
  const userIds = normalizeUserIds(targets);
  if (!userIds.length) return;
  if (await shouldSkipPendingReplayWrite()) {
    wsPendingReplayGuardTotal.inc({ reason: 'redis_memory_high' });
    const now = Date.now();
    if (now - pendingGuardLastWarnAtMs >= 30000) {
      pendingGuardLastWarnAtMs = now;
      logger.warn(
        {
          guardPct: WS_REPLAY_PENDING_MEMORY_GUARD_PCT,
          users: userIds.length,
          messageId,
        },
        'WS pending replay enqueue skipped: Redis memory guard active',
      );
    }
    return;
  }

  let enqueueUserIds = userIds;
  if (pendingReplayFilterEnabled()) {
    const { eligible, perClass } = await filterUsersEligibleForPendingReplay(userIds);
    enqueueUserIds = eligible;
    if (perClass.connected > 0) {
      pendingReplayRecipientTotal.inc({ class: 'connected' }, perClass.connected);
    }
    if (perClass.recent > 0) {
      pendingReplayRecipientTotal.inc({ class: 'recent' }, perClass.recent);
    }
    if (perClass.offlineSkipped > 0) {
      pendingReplayRecipientTotal.inc({ class: 'offline_skipped' }, perClass.offlineSkipped);
      offlinePendingSkippedTotal.inc(perClass.offlineSkipped);
    }
  } else {
    pendingReplayRecipientTotal.inc({ class: 'legacy_enqueue' }, userIds.length);
  }

  pendingReplayEntriesPerMessage.observe(enqueueUserIds.length);

  if (!enqueueUserIds.length) {
    return;
  }

  const score = Date.now();
  const minimal = buildPendingRedisPayload(payload, messageId);
  const payloadJson = JSON.stringify(minimal);
  const pipeline = redis.pipeline();
  pipeline.set(
    pendingMessageKey(messageId),
    payloadJson,
    'EX',
    WS_REPLAY_PENDING_TTL_SECONDS,
  );
  for (const userId of enqueueUserIds) {
    const userKey = pendingUserKey(userId);
    pipeline.zadd(userKey, score, messageId);
    pipeline.expire(userKey, WS_REPLAY_PENDING_TTL_SECONDS);
    pipeline.zremrangebyrank(userKey, 0, -(WS_REPLAY_PENDING_USER_MAX_ZSET + 1));
    pipeline.zcard(userKey);
  }
  const results = await pipeline.exec();
  for (let i = 0; i < enqueueUserIds.length; i += 1) {
    const base = 1 + (i * 4);
    const [, trimmedRaw] = results[base + 2] || [];
    const [, zcardRaw] = results[base + 3] || [];
    const trimmed = Number(trimmedRaw) || 0;
    const zcard = Number(zcardRaw) || 0;
    if (trimmed > 0) wsPendingReplayUserTrimmedTotal.inc(trimmed);
    wsPendingUserZsetSize.observe(zcard);
  }
}

async function shouldSkipPendingReplayWrite(): Promise<boolean> {
  if (!WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED) return false;
  const now = Date.now();
  if (now < pendingGuardCachedUntilMs) return pendingGuardCachedShouldSkip;
  pendingGuardCachedUntilMs = now + WS_REPLAY_PENDING_MEMORY_GUARD_CACHE_MS;
  pendingGuardCachedShouldSkip = false;
  try {
    const info = await redis.info('memory');
    const usedMatch = /(?:^|\n)used_memory:(\d+)(?:\n|$)/.exec(info);
    const maxMatch = /(?:^|\n)maxmemory:(\d+)(?:\n|$)/.exec(info);
    const used = usedMatch ? Number(usedMatch[1]) : 0;
    const max = maxMatch ? Number(maxMatch[1]) : 0;
    if (used > 0 && max > 0) {
      const pct = (used * 100) / max;
      pendingGuardCachedShouldSkip = pct >= WS_REPLAY_PENDING_MEMORY_GUARD_PCT;
    }
  } catch {
    pendingGuardCachedShouldSkip = false;
  }
  return pendingGuardCachedShouldSkip;
}

async function drainPendingMessagesForUser(userId: string) {
  if (!isRedisOperational()) return [];
  if (typeof userId !== 'string' || !userId) return [];
  const key = pendingUserKey(userId);
  const now = Date.now();
  const messageIds = await redis.zrangebyscore(
    key,
    '-inf',
    now,
    'LIMIT',
    0,
    WS_REPLAY_PENDING_DRAIN_LIMIT,
  );
  if (!Array.isArray(messageIds) || messageIds.length === 0) return [];

  const payloadKeys = messageIds.map((messageId) => pendingMessageKey(messageId));
  const payloadRows = await redis.mget(...payloadKeys);
  const pipeline = redis.pipeline();
  const drained: Record<string, unknown>[] = [];
  for (let i = 0; i < messageIds.length; i += 1) {
    const messageId = messageIds[i];
    const rawPayload = payloadRows[i];
    pipeline.zrem(key, messageId);
    if (typeof rawPayload !== 'string' || !rawPayload) continue;
    try {
      const parsed = JSON.parse(rawPayload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (isLegacyFullPendingPayload(parsed as Record<string, unknown>)) {
        drained.push(parsed as Record<string, unknown>);
        continue;
      }
      if ((parsed as Record<string, unknown>)[PENDING_MIN_MARKER] === true) {
        const hydrated = await hydratePendingPayload(parsed as Record<string, unknown>);
        if (hydrated) drained.push(hydrated);
        continue;
      }
    } catch {
      // Ignore invalid payloads; TTL cleanup will remove payload keys.
    }
  }
  await pipeline.exec();
  return drained;
}

module.exports = {
  enqueuePendingMessageForUsers,
  drainPendingMessagesForUser,
  WS_REPLAY_PENDING_TTL_SECONDS,
  WS_REPLAY_PENDING_DRAIN_LIMIT,
  WS_REPLAY_PENDING_USER_MAX_ZSET,
  pendingReplayFilterEnabled,
};
