
const { query, queryRead } = require('../db/pool');
const {
  READ_RECEIPT_TARGET_LOOKUP_CALLER,
  readReceiptTargetLookupReadDiagnosticFields,
} = require('./readReceipt/readReceiptTargetLookupDiag');
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
     JOIN communities co ON co.id = c.community_id
     WHERE c.id = $1::uuid
       AND (
         c.is_private = FALSE
         OR co.owner_id = $2::uuid
         OR EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = $2::uuid
         )
       )
       AND (
         co.owner_id = $2::uuid
         OR EXISTS (
           SELECT 1 FROM community_members community_member
           WHERE community_member.community_id = c.community_id
             AND community_member.user_id = $2::uuid
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

const MESSAGE_TARGET_ACCESS_EXPR = `CASE
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
            JOIN communities co ON co.id = c.community_id
            LEFT JOIN channel_members cm
              ON cm.channel_id = c.id
             AND cm.user_id = $2
            WHERE c.id = m.channel_id
              AND (c.is_private = FALSE OR co.owner_id = $2 OR cm.user_id IS NOT NULL)
              AND (
                co.owner_id = $2
                OR EXISTS (
                  SELECT 1
                  FROM community_members community_member
                  WHERE community_member.community_id = c.community_id
                    AND community_member.user_id = $2
                )
              )
          )
          ELSE FALSE
        END AS has_access`;

const MESSAGE_TARGET_SQL_LITE = `SELECT m.id,
        m.author_id,
        m.channel_id,
        m.conversation_id,
        m.created_at,
        ${MESSAGE_TARGET_ACCESS_EXPR}
 FROM messages m
 WHERE m.id = $1
   AND m.deleted_at IS NULL`;

const MESSAGE_TARGET_SQL_FULL = `SELECT m.id,
        m.author_id,
        m.channel_id,
        m.conversation_id,
        m.created_at,
        ch.community_id,
        ${MESSAGE_TARGET_ACCESS_EXPR}
 FROM messages m
 LEFT JOIN channels ch ON ch.id = m.channel_id
 WHERE m.id = $1
   AND m.deleted_at IS NULL`;

function messageTargetSql(includeCommunityId: boolean) {
  return includeCommunityId ? MESSAGE_TARGET_SQL_FULL : MESSAGE_TARGET_SQL_LITE;
}

async function loadMessageTargetFromPrimary(
  messageId,
  userId,
  includeCommunityId = true,
  targetLookupReadDiagnostics = undefined,
) {
  const readOpts =
    targetLookupReadDiagnostics && Object.keys(targetLookupReadDiagnostics).length
      ? { readDiagnostics: targetLookupReadDiagnostics }
      : undefined;
  const { rows } = await query(messageTargetSql(includeCommunityId), [messageId, userId], readOpts);
  return rows[0] || null;
}

async function loadMessageTargetFromReplicaThenPrimary(
  messageId,
  userId,
  includeCommunityId = true,
  targetLookupReadDiagnostics = undefined,
) {
  const readOpts =
    targetLookupReadDiagnostics && Object.keys(targetLookupReadDiagnostics).length
      ? { readDiagnostics: targetLookupReadDiagnostics }
      : undefined;
  const { rows } = await queryRead(
    messageTargetSql(includeCommunityId),
    [messageId, userId],
    readOpts,
  );
  const replicaRow = rows[0] || null;
  if (replicaRow) return replicaRow;

  return loadMessageTargetFromPrimary(
    messageId,
    userId,
    includeCommunityId,
    targetLookupReadDiagnostics,
  );
}

function buildMessageTargetLookupReadDiagnostics(messageId, userId, options) {
  const ctx = options && options.targetLookupLogContext;
  if (!ctx || ctx.kind !== READ_RECEIPT_TARGET_LOOKUP_CALLER) return undefined;
  return readReceiptTargetLookupReadDiagnosticFields({
    messageId,
    userId,
    requestId: ctx.requestId,
    includeCommunityId: options.includeCommunityId !== false,
    preferCache: options.preferCache === true,
    accessScope: 'unknown',
  });
}

async function loadMessageTargetForUser(messageId, userId, options: {
  preferCache?: boolean;
  includeCommunityId?: boolean;
  targetLookupLogContext?: { kind: string; requestId?: string };
} = {}) {
  const includeCommunityId = options.includeCommunityId !== false;
  const cacheShape = includeCommunityId ? 'full' : 'lite';
  const cacheKey = `msg_target:${cacheShape}:${messageId}:${userId}`;
  const preferCache = options.preferCache === true;
  const targetLookupReadDiagnostics = buildMessageTargetLookupReadDiagnostics(
    messageId,
    userId,
    options,
  );

  const cachedPromise = MSG_TARGET_CACHE_TTL_SECS > 0
    ? readScopedVersionedJsonCache({
        redis,
        cacheKey,
        isPayload: isMessageTargetCachePayload,
      })
    : Promise.resolve(null);

  if (preferCache) {
    const cached = await cachedPromise;
    if (cached?.data?.has_access) {
      return cached.data;
    }

    const row = await loadMessageTargetFromReplicaThenPrimary(
      messageId,
      userId,
      includeCommunityId,
      targetLookupReadDiagnostics,
    );
    if (row && row.has_access && MSG_TARGET_CACHE_TTL_SECS > 0) {
      const scope = rowAccessScope(row);
      if (scope) {
        writeScopedVersionedJsonCache({
          redis,
          cacheKey,
          scope,
          ttlSeconds: MSG_TARGET_CACHE_TTL_SECS,
          payloadWithoutVersion: { data: row },
        }).catch(() => {});
      }
    }
    return row;
  }

  const dbPromise = loadMessageTargetFromReplicaThenPrimary(
    messageId,
    userId,
    includeCommunityId,
    targetLookupReadDiagnostics,
  );

  // Concurrent race: resolve as soon as either gives us a definitive "yes" (with access).
  // If either returns null or has_access=false, wait for the other.
  const result = await new Promise<any>((resolve, reject) => {
    let pending = 2;
    let dbResult: any = null;
    let cachedResult: any = null;

    function checkDone() {
      if (--pending === 0) {
        // Both finished. Prefer DB result for freshness if both returned something,
        // but either one is better than nothing.
        resolve(dbResult || (cachedResult ? cachedResult.data : null));
      }
    }

    cachedPromise.then((cached) => {
      if (cached && cached.data && cached.data.has_access) {
        resolve(cached.data);
      } else {
        cachedResult = cached;
        checkDone();
      }
    }).catch(checkDone);

    dbPromise.then((row) => {
      if (row && row.has_access) {
        resolve(row);
      } else {
        dbResult = row;
        checkDone();
      }
    }).catch((err) => {
      // DB error: still allow Redis to win if it hits.
      checkDone();
    });
  });

  // Background: if DB load succeeded and we don't have a fresh cache entry, write it.
  if (result && result.has_access && MSG_TARGET_CACHE_TTL_SECS > 0) {
    const scope = rowAccessScope(result);
    if (scope) {
      writeScopedVersionedJsonCache({
        redis,
        cacheKey,
        scope,
        ttlSeconds: MSG_TARGET_CACHE_TTL_SECS,
        payloadWithoutVersion: { data: result },
      }).catch(() => {});
    }
  }

  return result;
}

module.exports = {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
};
