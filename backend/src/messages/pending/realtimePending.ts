
const redis = require('../../db/redis');
const { connectedUsersKey } = require('../../websocket/presenceKeys');
const logger = require('../../utils/logger');
const { loadHydratedMessagesByIds } = require('../messageHydrate');
const { wrapFanoutPayload } = require('../realtimePayload');
const {
  wsPendingEligibleKey,
  wsRecentConnectKey,
  wsReplayPendingEligibilityKey,
  WS_REPLAY_RECENT_USER_WINDOW_SECONDS,
} = require('../../websocket/recentConnect');
const { realtimePendingConfig } = require('../config/realtimePendingConfig');
const {
  wsPendingReplayUserTrimmedTotal,
  wsPendingUserZsetSize,
  wsPendingReplayGuardTotal,
  pendingReplayRecipientTotal,
  pendingReplayEntriesPerMessage,
  pendingReplaySecondProbeRecentUserTotal,
  offlinePendingSkippedTotal,
  redisExistsByPathTotal,
} = require('../../utils/metrics');

const {
  WS_REPLAY_PENDING_TTL_SECONDS,
  WS_REPLAY_PENDING_DRAIN_LIMIT,
  WS_REPLAY_PENDING_USER_MAX_ZSET,
  WS_REPLAY_PENDING_MEMORY_GUARD_PCT,
  WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED,
  WS_REPLAY_PENDING_MEMORY_GUARD_CACHE_MS,
  WS_REPLAY_PENDING_ONLY_ACTIVE,
  WS_REPLAY_PENDING_LEGACY_ALL,
  WS_PENDING_ELIGIBLE_LEGACY_FALLBACK,
  WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK,
  REDIS_PENDING_CLASSIFY_BATCH,
  PENDING_MIN_MARKER,
} = realtimePendingConfig;
let pendingGuardCachedUntilMs = 0;
let pendingGuardCachedShouldSkip = false;
let pendingGuardLastWarnAtMs = 0;

function pendingUserKey(userId: string) {
  return `ws:pending:user:${userId}`;
}

function pendingMessageKey(messageId: string) {
  return `ws:pending:message:${messageId}`;
}

/** Per-user WS connection id set (authoritative; used when SMISMEMBER is unavailable). */
function userConnectionSetKey(userId: string) {
  return `user:${userId}:connections`;
}

/**
 * True when the user is in `presence:connected_users`, which the WS presence coordinator
 * keeps in sync with non-empty `user:<id>:connections` (see `createPresenceCoordinator`).
 * Batching via SMISMEMBER collapses N per-user EXISTS into one Redis command per batch.
 */
async function batchUsersAppearGloballyConnected(userIds: string[]): Promise<boolean[]> {
  if (!userIds.length) return [];
  const globalKey = connectedUsersKey();
  try {
    const raw = await redis.call('SMISMEMBER', globalKey, ...userIds);
    const values = Array.isArray(raw) ? raw : [];
    if (values.length !== userIds.length) {
      throw new Error('SMISMEMBER result length mismatch');
    }
    return values.map((v: unknown) => Number(v) === 1);
  } catch (err: unknown) {
    const message = String((err as { message?: string })?.message || '');
    if (!/unknown command|wrong number of arguments|SMISMEMBER/i.test(message)) {
      throw err;
    }
    const pipe = redis.pipeline();
    for (const uid of userIds) {
      pipe.exists(userConnectionSetKey(uid));
    }
    redisExistsByPathTotal?.inc?.({ path: 'pending_replay_connection_fallback' }, userIds.length);
    const results = await pipe.exec();
    return results.map((row: [Error | null, unknown] | undefined) => Number(row?.[1] || 0) === 1);
  }
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

/** User ids already classified as "recent" for fanout (skip EXISTS on unified pending-eligible key). */
function recentTargetsUserIdSet(recentTargets?: string[]) {
  const out = new Set<string>();
  if (!Array.isArray(recentTargets) || !recentTargets.length) return out;
  for (const t of recentTargets) {
    if (typeof t !== 'string' || !t) continue;
    const id = t.startsWith('user:') ? t.slice(5) : t;
    if (id) out.add(id);
  }
  return out;
}

function pendingReplayFilterEnabled() {
  return WS_REPLAY_PENDING_ONLY_ACTIVE && !WS_REPLAY_PENDING_LEGACY_ALL;
}

/**
 * Returns user ids that should receive `ws:pending:user:*` zadd for this message.
 * Offline users still get history from Postgres on reconnect; DB replay covers gaps.
 *
 * @param recentUserIdsKnown - user ids already known recent from the same fanout pass
 *   (e.g. `recentConnectTargets`); skips EXISTS on `ws:pending_eligible:*` for them.
 * @param recentTargetsHintProvided - `true` when the caller passed `recentTargets` on `opts`
 *   (even if empty). Channel fanout uses this to avoid a second Redis EXISTS pass at large N.
 */
async function filterUsersEligibleForPendingReplay(
  userIds: string[],
  recentUserIdsKnown?: Set<string>,
  recentTargetsHintProvided?: boolean,
): Promise<{
  eligible: string[];
  perClass: { connected: number; recent: number; offlineSkipped: number };
}> {
  const perClass = { connected: 0, recent: 0, offlineSkipped: 0 };
  if (!userIds.length) {
    return { eligible: [], perClass };
  }

  const eligible: string[] = [];
  const knownRecent = recentUserIdsKnown instanceof Set ? recentUserIdsKnown : new Set<string>();
  const useReplayKey = WS_REPLAY_RECENT_USER_WINDOW_SECONDS > 0;
  const legacyFallback = WS_PENDING_ELIGIBLE_LEGACY_FALLBACK;
  const hintProvided = recentTargetsHintProvided === true;
  const conversationMarkerFallback =
    !legacyFallback && !hintProvided && WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK;
  const useSecondMarkerProbe = legacyFallback || conversationMarkerFallback;

  for (let offset = 0; offset < userIds.length; offset += REDIS_PENDING_CLASSIFY_BATCH) {
    const slice = userIds.slice(offset, offset + REDIS_PENDING_CLASSIFY_BATCH);
    const pendingProbeUids = slice.filter((uid) => !knownRecent.has(uid));
    const pendingProbePromise: Promise<Array<[Error | null, unknown] | null>> =
      pendingProbeUids.length
        ? (() => {
            const pendingPipe = redis.pipeline();
            for (const uid of pendingProbeUids) {
              pendingPipe.exists(wsPendingEligibleKey(uid));
            }
            redisExistsByPathTotal?.inc?.(
              { path: 'pending_replay_unified_marker' },
              pendingProbeUids.length,
            );
            return pendingPipe.exec() as Promise<Array<[Error | null, unknown] | null>>;
          })()
        : Promise.resolve([]);
    const hasConnFlagsPromise = batchUsersAppearGloballyConnected(slice);
    const [pendingRaw, hasConnFlags] = await Promise.all([
      pendingProbePromise,
      hasConnFlagsPromise,
    ]);
    const pendingByUid = new Map<string, boolean>();
    pendingProbeUids.forEach((uid, i) => {
      pendingByUid.set(uid, Number(pendingRaw[i]?.[1] || 0) === 1);
    });

    const phase1: Array<{
      uid: string;
      hasActiveConnection: boolean;
      pendingExists: boolean;
      fromHint: boolean;
    }> = [];

    for (let i = 0; i < slice.length; i += 1) {
      const uid = slice[i];
      const fromHint = knownRecent.has(uid);
      const pendingExists = fromHint ? false : pendingByUid.get(uid) === true;
      const hasActiveConnection = hasConnFlags[i] === true;
      phase1.push({ uid, hasActiveConnection, pendingExists, fromHint });
    }

    const needLegacyProbe: string[] = [];
    for (const row of phase1) {
      if (row.hasActiveConnection) {
        eligible.push(row.uid);
        perClass.connected += 1;
      } else if (row.fromHint) {
        eligible.push(row.uid);
        perClass.recent += 1;
      } else if (row.pendingExists) {
        eligible.push(row.uid);
        perClass.recent += 1;
      } else if (useSecondMarkerProbe) {
        needLegacyProbe.push(row.uid);
      } else {
        perClass.offlineSkipped += 1;
      }
    }

    if (!needLegacyProbe.length) {
      continue;
    }

    const leg = redis.pipeline();
    for (const uid of needLegacyProbe) {
      leg.exists(wsRecentConnectKey(uid));
      redisExistsByPathTotal?.inc?.({ path: 'pending_replay_legacy_marker' });
      if (useReplayKey) {
        leg.exists(wsReplayPendingEligibilityKey(uid));
        redisExistsByPathTotal?.inc?.({ path: 'pending_replay_legacy_marker' });
      }
    }
    const legRes = await leg.exec();
    let lj = 0;
    for (const uid of needLegacyProbe) {
      const exRecent = Number(legRes[lj++]?.[1] || 0) === 1;
      const exReplay = useReplayKey ? Number(legRes[lj++]?.[1] || 0) === 1 : false;
      if (exRecent || exReplay) {
        eligible.push(uid);
        perClass.recent += 1;
        if (conversationMarkerFallback) {
          pendingReplaySecondProbeRecentUserTotal.inc({ mode: 'conversation_marker' }, 1);
        } else if (legacyFallback) {
          pendingReplaySecondProbeRecentUserTotal.inc({ mode: 'legacy_global' }, 1);
        }
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

async function hydratePendingPayloads(
  entries: Array<{ parsed: Record<string, unknown>; messageId: string }>,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!entries.length) return out;
  const ids = entries.map((e) => e.messageId);
  const rows = await loadHydratedMessagesByIds(ids);
  for (const { parsed, messageId } of entries) {
    const row = rows.get(messageId);
    if (!row) continue;
    const event = typeof parsed.event === 'string' ? parsed.event : 'message:created';
    out.set(messageId, wrapFanoutPayload(event, row) as Record<string, unknown>);
  }
  return out;
}

/**
 * @param opts.recentTargets - `user:<id>` strings from the same publish pass; avoids EXISTS for those users.
 */
async function enqueuePendingMessageForUsers(
  targets: string[],
  payload: Record<string, unknown>,
  opts?: { recentTargets?: string[] },
) {
  if (!isRedisOperational()) return;
  const messageId = extractMessageId(payload);
  if (!messageId) return;
  const userIds = normalizeUserIds(targets);
  if (!userIds.length) return;
  const recentKnown = recentTargetsUserIdSet(opts?.recentTargets);
  const recentTargetsHintProvided =
    opts != null && Object.prototype.hasOwnProperty.call(opts, 'recentTargets');
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
    const { eligible, perClass } = await filterUsersEligibleForPendingReplay(
      userIds,
      recentKnown,
      recentTargetsHintProvided,
    );
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
  const toHydrate: Array<{ parsed: Record<string, unknown>; messageId: string }> = [];
  const legacyByIndex: Array<Record<string, unknown> | null> = new Array(messageIds.length).fill(null);

  for (let i = 0; i < messageIds.length; i += 1) {
    const messageId = messageIds[i];
    const rawPayload = payloadRows[i];
    pipeline.zrem(key, messageId);
    if (typeof rawPayload !== 'string' || !rawPayload) continue;
    try {
      const parsed = JSON.parse(rawPayload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (isLegacyFullPendingPayload(parsed as Record<string, unknown>)) {
        legacyByIndex[i] = parsed as Record<string, unknown>;
        continue;
      }
      if ((parsed as Record<string, unknown>)[PENDING_MIN_MARKER] === true) {
        toHydrate.push({ parsed: parsed as Record<string, unknown>, messageId });
      }
    } catch {
      // Ignore invalid payloads; TTL cleanup will remove payload keys.
    }
  }

  const hydratedMap = await hydratePendingPayloads(toHydrate);

  const drained: Record<string, unknown>[] = [];
  for (let i = 0; i < messageIds.length; i += 1) {
    const legacy = legacyByIndex[i];
    if (legacy) {
      drained.push(legacy);
      continue;
    }
    const messageId = messageIds[i];
    const h = hydratedMap.get(messageId);
    if (h) drained.push(h);
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
