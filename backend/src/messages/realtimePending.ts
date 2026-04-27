'use strict';

const redis = require('../db/redis');
const logger = require('../utils/logger');
const { loadHydratedMessageById } = require('./messageHydrate');
const { wrapFanoutPayload } = require('./realtimePayload');

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

const PENDING_MIN_MARKER = '__pendingMin';

function pendingUserKey(userId: string) {
  return `ws:pending:user:${userId}`;
}

function pendingMessageKey(messageId: string) {
  return `ws:pending:message:${messageId}`;
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
  for (const userId of userIds) {
    pipeline.zadd(pendingUserKey(userId), score, messageId);
    pipeline.expire(pendingUserKey(userId), WS_REPLAY_PENDING_TTL_SECONDS);
  }
  await pipeline.exec();
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
};
