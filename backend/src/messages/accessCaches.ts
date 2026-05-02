
const { query, queryRead, readPool } = require('../db/pool');
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
  scopeVersionKey,
} = require('../utils/accessVersionCache');
const {
  isCompatCachePayload,
  isMessageTargetCachePayload,
  writeScopedVersionedJsonCache,
} = require('../utils/versionedAccessCache');
const {
  msgTargetCacheTotal,
  msgTargetLookupSourceTotal,
  msgTargetLookupDurationMs,
} = require('../utils/metrics/msgTargetAccess');

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

function msgTargetMetricsCallerLabel(options) {
  return options && options.msgTargetMetricsCaller === 'read_receipt' ? 'read_receipt' : 'other';
}

function observeMsgTargetLookup(caller, shape, source, t0) {
  msgTargetLookupSourceTotal.inc({ caller, shape, source });
  msgTargetLookupDurationMs.observe({ caller, shape, source }, Math.max(0, Date.now() - t0));
}

async function readMsgTargetCacheOutcome(cacheKey) {
  if (MSG_TARGET_CACHE_TTL_SECS <= 0) {
    return { outcome: 'disabled', parsed: null };
  }
  let raw;
  try {
    raw = await redis.get(cacheKey);
  } catch {
    return { outcome: 'redis_error', parsed: null };
  }
  if (!raw) return { outcome: 'miss', parsed: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      await redis.del(cacheKey);
    } catch {
      /* ignore */
    }
    return { outcome: 'parse_error', parsed: null };
  }
  if (parsed === null) {
    return { outcome: 'miss', parsed: null };
  }
  if (typeof parsed !== 'object' || !isMessageTargetCachePayload(parsed)) {
    try {
      await redis.del(cacheKey);
    } catch {
      /* ignore */
    }
    return { outcome: 'parse_error', parsed: null };
  }
  let currentVersion;
  try {
    currentVersion = await readAccessVersion(redis, scopeVersionKey(parsed.scope));
  } catch {
    return { outcome: 'redis_error', parsed: null };
  }
  if (toAccessVersion(parsed.version) !== currentVersion) {
    try {
      await redis.del(cacheKey);
    } catch {
      /* ignore */
    }
    return { outcome: 'stale_version', parsed: null };
  }
  return { outcome: 'hit', parsed };
}

function trackMsgTargetCacheRead(cacheKey, caller, cacheShape) {
  return readMsgTargetCacheOutcome(cacheKey).then((out) => {
    msgTargetCacheTotal.inc({ caller, shape: cacheShape, result: out.outcome });
    return out;
  });
}

async function loadMessageTargetRowWithSource(
  messageId,
  userId,
  includeCommunityId,
  targetLookupReadDiagnostics,
) {
  const readOptsBase =
    targetLookupReadDiagnostics && Object.keys(targetLookupReadDiagnostics).length
      ? { readDiagnostics: targetLookupReadDiagnostics }
      : {};
  const readOpts: Record<string, unknown> = { ...readOptsBase };
  let usedFallback = false;
  if (readPool) {
    readOpts.onReadReplicaFallback = () => {
      usedFallback = true;
    };
  }
  const { rows } = await queryRead(
    messageTargetSql(includeCommunityId),
    [messageId, userId],
    readOpts,
  );
  const row = rows[0] || null;
  if (row) {
    if (!readPool) return { row, source: 'primary_direct' };
    return { row, source: usedFallback ? 'primary_fallback' : 'replica' };
  }
  if (!readPool) {
    return { row: null, source: 'primary_direct' };
  }
  const primaryRow = await loadMessageTargetFromPrimary(
    messageId,
    userId,
    includeCommunityId,
    targetLookupReadDiagnostics,
  );
  return { row: primaryRow, source: 'primary_direct' };
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
  msgTargetMetricsCaller?: 'read_receipt' | 'other';
} = {}) {
  const t0 = Date.now();
  const caller = msgTargetMetricsCallerLabel(options);
  const includeCommunityId = options.includeCommunityId !== false;
  const cacheShape = includeCommunityId ? 'full' : 'lite';
  const cacheKey = `msg_target:${cacheShape}:${messageId}:${userId}`;
  const preferCache = options.preferCache === true;
  const targetLookupReadDiagnostics = buildMessageTargetLookupReadDiagnostics(
    messageId,
    userId,
    options,
  );

  try {
    if (preferCache) {
      const cacheOut = await trackMsgTargetCacheRead(cacheKey, caller, cacheShape);
      if (cacheOut.parsed?.data?.has_access) {
        observeMsgTargetLookup(caller, cacheShape, 'cache', t0);
        return cacheOut.parsed.data;
      }

      const { row, source } = await loadMessageTargetRowWithSource(
        messageId,
        userId,
        includeCommunityId,
        targetLookupReadDiagnostics,
      );
      observeMsgTargetLookup(caller, cacheShape, source, t0);
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

    const cacheReadP = trackMsgTargetCacheRead(cacheKey, caller, cacheShape);
    const dbReadP = loadMessageTargetRowWithSource(
      messageId,
      userId,
      includeCommunityId,
      targetLookupReadDiagnostics,
    );

    let lookupFinalized = false;
    function finalizeLookupSource(source) {
      if (lookupFinalized) return;
      lookupFinalized = true;
      observeMsgTargetLookup(caller, cacheShape, source, t0);
    }

    const result = await new Promise<any>((resolve, reject) => {
      let pending = 2;
      let dbResult: any = null;
      let dbSource = 'replica';
      let cachedPayload: any = null;
      let dbFailed = false;

      function checkDone() {
        if (--pending !== 0) return;
        const final = dbResult || (cachedPayload ? cachedPayload.data : null);
        if (!lookupFinalized) {
          let lookupSource = 'replica';
          if (dbFailed && !final) lookupSource = 'error';
          else if (dbResult != null) lookupSource = dbSource;
          else if (cachedPayload && cachedPayload.data != null) lookupSource = 'cache';
          else lookupSource = dbSource;
          finalizeLookupSource(lookupSource);
        }
        resolve(final);
      }

      cacheReadP.then((cacheOut) => {
        cachedPayload = cacheOut.parsed;
        if (cacheOut.parsed?.data?.has_access) {
          finalizeLookupSource('cache');
          resolve(cacheOut.parsed.data);
          return;
        }
        checkDone();
      }).catch(() => {
        checkDone();
      });

      dbReadP.then(({ row, source }) => {
        dbSource = source;
        if (row && row.has_access) {
          finalizeLookupSource(source);
          resolve(row);
          return;
        }
        dbResult = row;
        checkDone();
      }).catch(() => {
        dbFailed = true;
        dbResult = null;
        checkDone();
      });
    });

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
  } catch (err) {
    observeMsgTargetLookup(caller, cacheShape, 'error', t0);
    throw err;
  }
}

module.exports = {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
};
