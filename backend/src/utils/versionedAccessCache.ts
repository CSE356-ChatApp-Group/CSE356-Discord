'use strict';

const {
  toAccessVersion,
  scopeVersionKey,
  readAccessVersion,
} = require('./accessVersionCache');

export type AccessScope = { kind: 'channel' | 'conversation'; id: string };

export type CompatCachePayload = {
  channelId: string | null;
  version: number;
};

export type MessageTargetCachePayload = {
  data: any;
  scope: AccessScope;
  version: number;
};

export type AttachmentAccessCachePayload = {
  found: true;
  allowed: true;
  attachment: any;
  scope: AccessScope;
  version: number;
};

export function isAccessScope(scope: any): scope is AccessScope {
  return Boolean(
    scope
    && typeof scope.id === 'string'
    && (scope.kind === 'channel' || scope.kind === 'conversation'),
  );
}

export function isCompatCachePayload(payload: any): payload is CompatCachePayload {
  return Boolean(
    payload
    && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, 'channelId')
    && payload.channelId !== undefined
    && (payload.channelId === null || typeof payload.channelId === 'string')
    && Number.isFinite(Number(payload.version)),
  );
}

export function isMessageTargetCachePayload(payload: any): payload is MessageTargetCachePayload {
  return Boolean(
    payload
    && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, 'data')
    && isAccessScope(payload.scope)
    && Number.isFinite(Number(payload.version)),
  );
}

export function isAttachmentAccessCachePayload(payload: any): payload is AttachmentAccessCachePayload {
  return Boolean(
    payload
    && payload.found === true
    && payload.allowed === true
    && Object.prototype.hasOwnProperty.call(payload, 'attachment')
    && isAccessScope(payload.scope)
    && Number.isFinite(Number(payload.version)),
  );
}

function safeParseJson(raw: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function invalidateKey(redis, cacheKey: string) {
  try {
    await redis.del(cacheKey);
  } catch {
    // Best-effort invalidation.
  }
}

export async function readScopedVersionedJsonCache({
  redis,
  cacheKey,
  isPayload,
}: {
  redis: any;
  cacheKey: string;
  isPayload: (payload: any) => boolean;
}) {
  const raw = await redis.get(cacheKey).catch(() => null);
  if (!raw) return null;
  const parsed = safeParseJson(raw);
  if (!parsed || !isPayload(parsed)) {
    await invalidateKey(redis, cacheKey);
    return null;
  }
  const currentVersion = await readAccessVersion(redis, scopeVersionKey(parsed.scope));
  if (toAccessVersion(parsed.version) !== currentVersion) {
    await invalidateKey(redis, cacheKey);
    return null;
  }
  return parsed;
}

export async function writeScopedVersionedJsonCache({
  redis,
  cacheKey,
  scope,
  ttlSeconds,
  payloadWithoutVersion,
}: {
  redis: any;
  cacheKey: string;
  scope: AccessScope;
  ttlSeconds: number;
  payloadWithoutVersion: Record<string, any>;
}) {
  const version = await readAccessVersion(redis, scopeVersionKey(scope));
  await redis.set(
    cacheKey,
    JSON.stringify({
      ...payloadWithoutVersion,
      scope,
      version,
    }),
    'EX',
    ttlSeconds,
  );
}

