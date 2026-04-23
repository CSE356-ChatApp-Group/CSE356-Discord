'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const {
  rowAccessScope,
} = require('../utils/accessVersionCache');
const {
  isAttachmentAccessCachePayload,
  readScopedVersionedJsonCache,
  writeScopedVersionedJsonCache,
} = require('../utils/versionedAccessCache');

const _attachmentGetCacheTtl = parseInt(process.env.ATTACHMENT_GET_CACHE_TTL_SECS || '30', 10);
const ATTACHMENT_GET_CACHE_TTL_SECS =
  Number.isFinite(_attachmentGetCacheTtl) && _attachmentGetCacheTtl >= 0
    ? _attachmentGetCacheTtl
    : 30;

function cacheKey(attachmentId, userId) {
  return `attachment:get:${attachmentId}:${userId}`;
}

async function readCachedAttachmentAccess(attachmentId, userId) {
  if (ATTACHMENT_GET_CACHE_TTL_SECS <= 0) return null;
  const key = cacheKey(attachmentId, userId);
  try {
    const parsed = await readScopedVersionedJsonCache({
      redis,
      cacheKey: key,
      isPayload: isAttachmentAccessCachePayload,
    });
    if (!parsed) return null;
    return {
      found: true,
      allowed: Boolean(parsed.allowed),
      attachment: parsed.attachment,
    };
  } catch {
    return null;
  }
}

async function writeCachedAttachmentAccess(attachmentId, userId, payload) {
  if (ATTACHMENT_GET_CACHE_TTL_SECS <= 0) return;
  if (!payload || payload.found !== true || payload.allowed !== true || !payload.attachment) return;
  const key = cacheKey(attachmentId, userId);
  try {
    const scope = rowAccessScope(payload.attachment);
    if (!scope) return;
    await writeScopedVersionedJsonCache({
      redis,
      cacheKey: key,
      scope,
      ttlSeconds: ATTACHMENT_GET_CACHE_TTL_SECS,
      payloadWithoutVersion: {
        found: true,
        allowed: true,
        attachment: payload.attachment,
      },
    });
  } catch {
    // Best-effort cache write.
  }
}

async function loadAttachmentForUser(attachmentId, userId) {
  const cached = await readCachedAttachmentAccess(attachmentId, userId);
  if (cached) return cached;

  const { rows } = await query(
    `SELECT a.*,
            m.channel_id,
            m.conversation_id,
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
     FROM attachments a
     JOIN messages m
       ON m.id = a.message_id
      AND m.deleted_at IS NULL
     WHERE a.id = $1`,
    [attachmentId, userId],
  );

  if (!rows.length) {
    return { found: false };
  }

  const row = rows[0];
  const result = {
    found: true,
    allowed: Boolean(row.has_access),
    attachment: row,
  };
  writeCachedAttachmentAccess(attachmentId, userId, result).catch(() => {});
  return result;
}

module.exports = {
  loadAttachmentForUser,
};
