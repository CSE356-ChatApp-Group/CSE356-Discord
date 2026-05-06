/**
 * Presence service
 *
 * Presence is stored in Redis (TTL-based) as the source of truth for
 * real-time status, with a periodic mirror into Postgres for analytics/history.
 *
 * Redis key:  presence:<userId>   value: 'online' | 'idle' | 'away' | 'offline'
 * TTL:        90 seconds (refreshed by heartbeats from the WS server)
 *
 * When a key expires, the user is effectively 'offline'.
 */


const redis = require("../db/redis");
const { redisBatchMget } = require("../db/redisBatch");
const {
  REDIS_LUA_IDS,
  registerRedisLuaScript,
  redisEvalSha,
} = require("../db/redisLua");
const { PRESENCE_DB_CAS_LUA } = require("../db/redisLuaScripts");
const { publishUserFeedTargets } = require("../websocket/userFeed");
const { query, withTransaction } = require("../db/pool");
const overload = require("../utils/overload");
const logger = require("../utils/logger");
const {
  presenceFanoutTotal,
  presenceFanoutTargetsInvalidationTotal,
  presenceFanoutTargetsInvalidationKeysTotal,
  presenceFanoutTargetsInvalidationDurationMs,
} = require("../utils/metrics");
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require("../messages/messageInsertLockPressure");

const TTL_SECONDS = 90;
const PRESENCE_DB_CURSOR_TTL_SECS = parseInt(process.env.PRESENCE_DB_CURSOR_TTL_SECS || '300', 10);
/** Away-message text in Redis must expire so volatile-lru can reclaim abandoned keys. */
const AWAY_MESSAGE_REDIS_TTL_SECS = (() => {
  const raw = parseInt(process.env.AWAY_MESSAGE_REDIS_TTL_SECS || '2592000', 10);
  if (!Number.isFinite(raw) || raw < 3600) return 2_592_000;
  return Math.min(86_400 * 90, raw);
})();

registerRedisLuaScript(REDIS_LUA_IDS.PRESENCE_DB_CAS, PRESENCE_DB_CAS_LUA);

function presenceDbCursorKey(userId) {
  return `presence_db_cursor:${userId}`;
}

const rawFanoutCacheTtl = Number(process.env.PRESENCE_FANOUT_CACHE_TTL_SECONDS || 120);
const PRESENCE_FANOUT_CACHE_TTL_SECONDS = Number.isFinite(rawFanoutCacheTtl) && rawFanoutCacheTtl > 0
  ? Math.floor(rawFanoutCacheTtl)
  : 120;

function presenceStatusKey(userId) {
  return `presence:${userId}`;
}

function awayMessageKey(userId) {
  return `presence:${userId}:away_message`;
}

function connectionSetKey(userId) {
  return `user:${userId}:connections`;
}

function connectionStatusHashKey(userId) {
  return `user:${userId}:connection_status`;
}

function fanoutTargetsKey(userId) {
  return `presence:${userId}:fanout_targets`;
}

const PRESENCE_FANOUT_RECIPIENTS_CACHE_VERSION = 2;
const PRESENCE_FANOUT_RECIPIENT_LOOKUP_MODE = String(
  process.env.PRESENCE_FANOUT_RECIPIENT_LOOKUP_MODE || 'db_cache',
).toLowerCase();
const PRESENCE_DB_MIRROR_MODE = String(
  process.env.PRESENCE_DB_MIRROR_MODE || 'async',
).toLowerCase();
const PRESENCE_DB_MIRROR_FLUSH_INTERVAL_MS = (() => {
  const raw = parseInt(process.env.PRESENCE_DB_MIRROR_FLUSH_INTERVAL_MS || '1000', 10);
  if (!Number.isFinite(raw) || raw < 100) return 1000;
  return Math.min(30_000, raw);
})();
const PRESENCE_DB_MIRROR_BATCH_SIZE = (() => {
  const raw = parseInt(process.env.PRESENCE_DB_MIRROR_BATCH_SIZE || '250', 10);
  if (!Number.isFinite(raw) || raw < 1) return 250;
  return Math.min(2000, raw);
})();

const pendingPresenceDbMirrors = new Map();
let presenceMirrorFlushTimer = null;
let presenceMirrorFlushInFlight = false;

function shouldUsePresenceDbMirror() {
  return PRESENCE_DB_MIRROR_MODE !== 'off' && PRESENCE_DB_MIRROR_MODE !== 'disabled';
}

function shouldMirrorPresenceInline() {
  return PRESENCE_DB_MIRROR_MODE === 'inline' || PRESENCE_DB_MIRROR_MODE === 'sync';
}

function enqueuePresenceDbMirror(userId, status, customMsg) {
  if (!shouldUsePresenceDbMirror()) return;
  pendingPresenceDbMirrors.set(userId, {
    userId,
    status,
    customMsg: status === 'away' ? customMsg : null,
  });
}

async function flushPresenceDbMirrorBatch() {
  if (presenceMirrorFlushInFlight || pendingPresenceDbMirrors.size === 0) return;
  presenceMirrorFlushInFlight = true;
  const batch = [];
  for (const [userId, payload] of pendingPresenceDbMirrors) {
    pendingPresenceDbMirrors.delete(userId);
    batch.push(payload);
    if (batch.length >= PRESENCE_DB_MIRROR_BATCH_SIZE) break;
  }

  try {
    await query(
      `INSERT INTO presence_snapshots (user_id, status, custom_msg, updated_at)
       SELECT *
       FROM UNNEST($1::uuid[], $2::presence_status[], $3::text[], $4::timestamptz[])
            AS payload(user_id, status, custom_msg, updated_at)
       ON CONFLICT (user_id) DO UPDATE SET
         status = EXCLUDED.status,
         custom_msg = EXCLUDED.custom_msg,
         updated_at = EXCLUDED.updated_at`,
      [
        batch.map((row) => row.userId),
        batch.map((row) => row.status),
        batch.map((row) => row.customMsg),
        batch.map(() => new Date().toISOString()),
      ],
    );
  } catch (err) {
    logger.debug(
      { err, batchSize: batch.length },
      'presence: async DB mirror batch failed',
    );
  } finally {
    presenceMirrorFlushInFlight = false;
  }
}

function startPresenceMirrorFlushInterval() {
  if (presenceMirrorFlushTimer || shouldMirrorPresenceInline() || !shouldUsePresenceDbMirror()) {
    return;
  }
  presenceMirrorFlushTimer = setInterval(() => {
    void flushPresenceDbMirrorBatch();
  }, PRESENCE_DB_MIRROR_FLUSH_INTERVAL_MS);
  if (typeof presenceMirrorFlushTimer.unref === 'function') {
    presenceMirrorFlushTimer.unref();
  }
}

function stopPresenceMirrorFlushInterval() {
  if (!presenceMirrorFlushTimer) return;
  clearInterval(presenceMirrorFlushTimer);
  presenceMirrorFlushTimer = null;
}

/** Cap keys per Redis UNLINK/DEL to avoid multi-thousand-argument commands (main-thread stalls).
 *  512 caused 15–43 ms Redis stalls per call; 50 keeps each call under ~4 ms. */
const PRESENCE_FANOUT_TARGETS_UNLINK_CHUNK = (() => {
  const raw = parseInt(process.env.PRESENCE_FANOUT_TARGETS_UNLINK_CHUNK || '50', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 512) : 50;
})();

function redisSupportsUnlink(redisClient) {
  return typeof redisClient.unlink === 'function';
}

/**
 * @param {'single' | 'bulk'} mode single = one logical invalidation (one or few keys); bulk = member-wide sweep
 */
async function unlinkOrDelPresenceFanoutTargetKeys(redisClient, keys, mode) {
  if (!keys.length) return;
  const startedAt = process.hrtime.bigint();
  if (mode === 'bulk') {
    presenceFanoutTargetsInvalidationKeysTotal.inc({ mode: 'bulk' }, keys.length);
  }
  const useUnlink = redisSupportsUnlink(redisClient);
  const commandLabel = useUnlink ? 'unlink' : 'del_fallback';
  const chunkSize = mode === 'bulk' ? PRESENCE_FANOUT_TARGETS_UNLINK_CHUNK : keys.length;

  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    if (useUnlink) {
      await redisClient.unlink(...chunk);
    } else {
      await redisClient.del(...chunk);
    }
    presenceFanoutTargetsInvalidationTotal.inc({ mode, command: commandLabel }, 1);
  }

  presenceFanoutTargetsInvalidationDurationMs.observe(
    { mode },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );
}

async function invalidatePresenceFanoutTargets(userId) {
  await unlinkOrDelPresenceFanoutTargetKeys(redis, [fanoutTargetsKey(userId)], 'single');
}

async function invalidatePresenceFanoutTargetsBulk(userIds) {
  const keys = [...new Set(
    (Array.isArray(userIds) ? userIds : [])
      .filter((userId) => typeof userId === 'string' && userId)
      .map((userId) => fanoutTargetsKey(userId))
  )];
  if (!keys.length) return;
  await unlinkOrDelPresenceFanoutTargetKeys(redis, keys, 'bulk');
}

function parsePresenceFanoutRecipientsCached(cached) {
  try {
    const parsed = JSON.parse(cached);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.v === PRESENCE_FANOUT_RECIPIENTS_CACHE_VERSION &&
      Array.isArray(parsed.u)
    ) {
      return [...new Set(
        parsed.u.filter((value) => typeof value === 'string' && value)
      )];
    }
    if (Array.isArray(parsed)) {
      return [...new Set(
        parsed.filter((value) => typeof value === 'string' && value)
      )];
    }
  } catch {
    return null;
  }
  return null;
}

async function getPresenceFanoutRecipientUserIds(userId) {
  if (PRESENCE_FANOUT_RECIPIENT_LOOKUP_MODE === 'self') {
    return [userId];
  }
  const cacheKey = fanoutTargetsKey(userId);
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = parsePresenceFanoutRecipientsCached(cached);
    if (parsed) return parsed;
    await unlinkOrDelPresenceFanoutTargetKeys(redis, [cacheKey], 'single');
  }

  if (
    PRESENCE_FANOUT_RECIPIENT_LOOKUP_MODE === 'cache_only' ||
    PRESENCE_FANOUT_RECIPIENT_LOOKUP_MODE === 'redis_only'
  ) {
    return [userId];
  }

  const { rows } = await query(
    `SELECT recipient_id::text AS user_id
       FROM (
         SELECT cm_other.user_id AS recipient_id
           FROM community_members cm_self
           JOIN community_members cm_other
             ON cm_other.community_id = cm_self.community_id
          WHERE cm_self.user_id = $1
            AND cm_other.user_id <> $1::uuid
         UNION ALL
         SELECT cp_other.user_id AS recipient_id
           FROM conversation_participants cp_self
           JOIN conversation_participants cp_other
             ON cp_other.conversation_id = cp_self.conversation_id
            AND cp_other.left_at IS NULL
          WHERE cp_self.user_id = $1
            AND cp_self.left_at IS NULL
            AND cp_other.user_id <> $1::uuid
       ) recipients
      WHERE recipient_id IS NOT NULL`,
    [userId],
  );

  const recipientUserIds = [...new Set(
    rows
      .map((row) => row.user_id)
      .filter((value) => typeof value === 'string' && value)
  )];

  await redis.set(
    cacheKey,
    JSON.stringify({ v: PRESENCE_FANOUT_RECIPIENTS_CACHE_VERSION, u: recipientUserIds }),
    'EX',
    PRESENCE_FANOUT_CACHE_TTL_SECONDS,
  );

  return recipientUserIds;
}

function normalizeAwayMessage(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

async function setAwayMessage(userId, message) {
  const normalized = normalizeAwayMessage(message);
  if (!normalized) {
    await redis.del(awayMessageKey(userId));
    return null;
  }
  await redis.set(awayMessageKey(userId), normalized, 'EX', AWAY_MESSAGE_REDIS_TTL_SECS);
  return normalized;
}

async function getAwayMessage(userId) {
  const msg = await redis.get(awayMessageKey(userId));
  return msg || null;
}

async function syncConnectionStatuses(userId, status) {
  const connectionIds = await redis.smembers(connectionSetKey(userId));
  if (!connectionIds.length) return;

  const pipeline = redis.pipeline();
  for (const connectionId of connectionIds) {
    pipeline.hset(connectionStatusHashKey(userId), connectionId, status);
  }
  await pipeline.exec();
}

async function setPresence(userId, status, awayMessage) {
  const key = presenceStatusKey(userId);
  const awayKey = awayMessageKey(userId);
  const [previousStatus, previousAwayMessage] = await redis.mget(key, awayKey);

  let nextAwayMessage = null;

  if (status === "offline") {
    if (!previousStatus && !previousAwayMessage) {
      return;
    }
    await redis.del(key, awayKey);
  } else {
    const pipeline = redis.pipeline();
    pipeline.set(key, status, "EX", TTL_SECONDS);
    if (status === "away") {
      if (awayMessage === undefined) {
        nextAwayMessage = previousAwayMessage || null;
      } else {
        nextAwayMessage = normalizeAwayMessage(awayMessage);
        if (nextAwayMessage) {
          pipeline.set(awayKey, nextAwayMessage);
        } else {
          pipeline.del(awayKey);
        }
      }
    } else {
      pipeline.del(awayKey);
    }
    await pipeline.exec();

    const unchangedStatus = previousStatus === status;
    const unchangedAwayMessage = status === "away"
      ? (previousAwayMessage || null) === nextAwayMessage
      : !previousAwayMessage;

    if (unchangedStatus && unchangedAwayMessage) {
      return;
    }
  }

  const statusChanged = previousStatus !== status;

  const shouldFanout =
    !overload.shouldThrottlePresenceFanout() ||
    statusChanged ||
    status === "away" ||
    status === "offline";

  presenceFanoutTotal.inc({ status, throttled: String(!shouldFanout) });
  logger.debug({
    event: "presence.fanout",
    userId,
    status,
    throttled: !shouldFanout,
  });

  if (shouldFanout) {
    const payload = {
      event: "presence:updated",
      data: {
        userId,
        status,
        awayMessage: status === "away" ? nextAwayMessage : null,
      },
    };

    try {
      const recipientUserIds = await getPresenceFanoutRecipientUserIds(userId);
      await publishUserFeedTargets(
        recipientUserIds.length ? recipientUserIds : [userId],
        payload,
      );
    } catch (err) {
      logger.debug({ err, userId }, 'Presence recipient fanout lookup failed');
      await publishUserFeedTargets([userId], payload);
    }
  }

  const skipPresenceDbMirror =
    overload.shouldSkipPresenceMirror() ||
    getShouldDeferReadReceiptForInsertLockPressure();
  if (!skipPresenceDbMirror) {
    // Redis CAS gate: deduplicate presence DB writes across workers for the same user.
    // Only the first worker to observe a new status value fires the DB upsert.
    const dbCursorKey = presenceDbCursorKey(userId);
    const cursorValue = `${status}:${status === "away" ? (nextAwayMessage || "") : ""}`;
    let shouldWriteDb = true;
    try {
      const casResult = await redisEvalSha(
        redis,
        REDIS_LUA_IDS.PRESENCE_DB_CAS,
        1,
        dbCursorKey,
        cursorValue,
        String(PRESENCE_DB_CURSOR_TTL_SECS),
      );
      shouldWriteDb = casResult === 1;
    } catch (redisErr) {
      // Fail open — if Redis is unavailable, write DB anyway
      logger.warn({ err: redisErr, userId }, 'presence: Redis CAS eval failed, writing DB anyway');
    }
    if (shouldWriteDb && shouldUsePresenceDbMirror()) {
      const customMsg = status === "away" ? nextAwayMessage : null;
      if (shouldMirrorPresenceInline()) {
        // Compatibility mode for diagnostics. Production should prefer async batching.
        withTransaction(async (client) => {
          await client.query('SET LOCAL synchronous_commit = off');
          await client.query(
            `INSERT INTO presence_snapshots (user_id, status, custom_msg, updated_at)
             VALUES ($1, $2::presence_status, $3, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
               status = EXCLUDED.status,
               custom_msg = EXCLUDED.custom_msg,
               updated_at = NOW()`,
            [userId, status, customMsg],
          );
        }).catch(() => {});
      } else {
        enqueuePresenceDbMirror(userId, status, customMsg);
      }
    }
  }
}

async function getPresence(userId) {
  const val = await redis.get(presenceStatusKey(userId));
  return val || "offline";
}

async function getPresenceDetails(userId) {
  const [[, statusVal], [, awayVal]] = await redis
    .pipeline()
    .get(presenceStatusKey(userId))
    .get(awayMessageKey(userId))
    .exec();
  const status = statusVal || "offline";
  const awayMessage = status === "away" ? (awayVal || null) : null;
  return { status, awayMessage };
}

async function getBulkPresence(userIds) {
  if (!userIds.length) return {};
  const keys = userIds.map((id) => presenceStatusKey(id));
  const values = await redisBatchMget(redis, keys);
  return Object.fromEntries(
    userIds.map((id, i) => [id, values[i] || "offline"]),
  );
}

async function getBulkPresenceDetails(userIds) {
  if (!userIds.length) return {};
  const statusKeys = userIds.map((id) => presenceStatusKey(id));
  const statuses = await redisBatchMget(redis, statusKeys);
  const awayUserIds = [];
  userIds.forEach((id, index) => {
    if ((statuses[index] || "offline") === "away") {
      awayUserIds.push(id);
    }
  });

  const awayMessagesByUserId = {};
  if (awayUserIds.length > 0) {
    const awayMessageKeys = awayUserIds.map((id) => awayMessageKey(id));
    const awayValues = await redisBatchMget(redis, awayMessageKeys);
    awayUserIds.forEach((id, index) => {
      awayMessagesByUserId[id] = awayValues[index] || null;
    });
  }

  const details = {};
  userIds.forEach((id, index) => {
    const status = statuses[index] || "offline";
    const awayMessage = status === "away" ? awayMessagesByUserId[id] || null : null;
    details[id] = { status, awayMessage };
  });
  return details;
}

module.exports = {
  setPresence,
  setAwayMessage,
  getAwayMessage,
  syncConnectionStatuses,
  invalidatePresenceFanoutTargets,
  invalidatePresenceFanoutTargetsBulk,
  getPresence,
  getPresenceDetails,
  getBulkPresence,
  getBulkPresenceDetails,
  startPresenceMirrorFlushInterval,
  stopPresenceMirrorFlushInterval,
  flushPresenceDbMirrorBatch,
};
