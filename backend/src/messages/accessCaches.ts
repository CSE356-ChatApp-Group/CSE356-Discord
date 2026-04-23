'use strict';

const { query, queryRead } = require('../db/pool');
const redis = require('../db/redis');
const {
  channelAccessVersionKey,
  toAccessVersion,
  rowAccessScope,
  readAccessVersion,
} = require('../utils/accessVersionCache');
const {
  isCompatCachePayload,
  isMessageTargetCachePayload,
  readScopedVersionedJsonCache,
  writeScopedVersionedJsonCache,
} = require('../utils/versionedAccessCache');

// Message target cache: stores the full result of loadMessageTargetForUser (including
// has_access) keyed by messageId+userId. TTL remains a backstop; membership/version
// keys provide fast invalidation on access changes.
const _msgTargetCacheTtl = parseInt(process.env.MSG_TARGET_CACHE_TTL_SECS || '30', 10);
const MSG_TARGET_CACHE_TTL_SECS =
  Number.isFinite(_msgTargetCacheTtl) && _msgTargetCacheTtl >= 0
    ? _msgTargetCacheTtl
    : 30;

// Cache the UUID→channelId resolution for the legacy conversationId= compat shim.
// Per (uuid, userId) because access is user-specific (private channels).
const CHANNEL_COMPAT_CACHE_TTL_SECS = parseInt(process.env.CHANNEL_COMPAT_CACHE_TTL_SECS || '60', 10);

/**
 * Course harness / generated client compatibility: some clients call
 * `GET /messages?conversationId=<uuid>` for channel history. When `channelId`
 * is absent, treat the UUID as channel id if the user can access that channel.
 */
async function channelIdIfOnlyConversationQueryParam(uuid, userId) {
  const cacheKey = `ch_compat:${uuid}:${userId}`;
  const versionKey = channelAccessVersionKey(uuid);

  if (CHANNEL_COMPAT_CACHE_TTL_SECS > 0) {
    try {
      const [cached, rawVersion] = await redis.mget(cacheKey, versionKey);
      if (cached) {
        let parsed: any = null;
        try { parsed = JSON.parse(cached); } catch {}
        if (
          isCompatCachePayload(parsed)
          && toAccessVersion(parsed.version) === toAccessVersion(rawVersion)
        ) {
          return parsed.channelId ?? null;
        }
        redis.del(cacheKey).catch(() => {});
      }
    } catch {
      // Fail open.
    }
  }

  const { rows } = await query(
    `SELECT c.id::text AS id
     FROM channels c
     JOIN community_members community_member
       ON community_member.community_id = c.community_id
      AND community_member.user_id = $2::uuid
     WHERE c.id = $1::uuid
       AND (
         c.is_private = FALSE
         OR EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = $2::uuid
         )
       )
     LIMIT 1`,
    [uuid, userId],
  );
  const result = rows[0]?.id ?? null;

  if (CHANNEL_COMPAT_CACHE_TTL_SECS > 0) {
    readAccessVersion(redis, versionKey)
      .then((version) => redis.set(
        cacheKey,
        JSON.stringify({ channelId: result, version }),
        'EX',
        CHANNEL_COMPAT_CACHE_TTL_SECS,
      ))
      .catch(() => {});
  }
  return result;
}

/**
 * Load message target and caller access in one query for hot read-receipt path.
 * Cache is keyed by (messageId, userId) and version-validated against channel/
 * conversation membership version keys before serving.
 */
async function loadMessageTargetForUser(messageId, userId) {
  const cacheKey = `msg_target:${messageId}:${userId}`;

  if (MSG_TARGET_CACHE_TTL_SECS > 0) {
    const cached = await readScopedVersionedJsonCache({
      redis,
      cacheKey,
      isPayload: isMessageTargetCachePayload,
    });
    if (cached) return cached.data;
  }

  const { rows } = await queryRead(
    `SELECT m.id,
            m.author_id,
            m.channel_id,
            m.conversation_id,
            m.created_at,
            ch.community_id,
            CASE
              WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                SELECT 1
                FROM conversation_participants cp
                WHERE cp.conversation_id = m.conversation_id
                  AND cp.user_id = $2
                  AND cp.left_at IS NULL
              )
              WHEN m.channel_id IS NOT NULL THEN EXISTS (
                SELECT 1
                FROM channels c
                JOIN community_members community_member
                  ON community_member.community_id = c.community_id
                 AND community_member.user_id = $2
                LEFT JOIN channel_members cm
                  ON cm.channel_id = c.id
                 AND cm.user_id = $2
                WHERE c.id = m.channel_id
                  AND (c.is_private = FALSE OR cm.user_id IS NOT NULL)
              )
              ELSE FALSE
            END AS has_access
     FROM messages m
     LEFT JOIN channels ch ON ch.id = m.channel_id
     WHERE m.id = $1
       AND m.deleted_at IS NULL`,
    [messageId, userId],
  );
  const result = rows[0] || null;

  if (result && MSG_TARGET_CACHE_TTL_SECS > 0) {
    const scope = rowAccessScope(result);
    if (scope) {
      writeScopedVersionedJsonCache({
        redis,
        cacheKey,
        scope,
        ttlSeconds: MSG_TARGET_CACHE_TTL_SECS,
        payloadWithoutVersion: { data: result },
      })
        .catch(() => {});
    }
  }

  return result;
}

module.exports = {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
};
