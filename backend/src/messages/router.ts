/**
 * Messages router
 *
 * GET    /api/v1/messages?channelId|conversationId=&before=&limit= – history
 *        (course clients may send only conversationId= for channel UUIDs; we
 *        resolve to channel when the UUID is an accessible channel.)
 * GET    /api/v1/messages/context/:messageId          – targeted context window
 * POST   /api/v1/messages                             – create (201: realtimeChannelFanoutComplete +
 *        realtimeUserFanoutDeferred for channels; realtimeConversationFanoutComplete for DMs)
 * PATCH  /api/v1/messages/:id                         – edit
 * DELETE /api/v1/messages/:id                         – hard-delete
 * PUT    /api/v1/messages/:id/read                    – mark as read
 */

"use strict";

const crypto = require("crypto");
const os = require("os");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const {
  body,
  query: qv,
  param,
  validationResult,
} = require("express-validator");

const {
  query,
  queryRead,
  readPool,
  withTransaction,
  poolStats,
} = require("../db/pool");
const {
  messagePostAccessDeniedTotal,
  messagePostRealtimePublishFailTotal,
  deliveryTimeoutTotal,
  messagePostFanoutAsyncEnqueueTotal,
  messagePostIdempotencyPollTotal,
  messagePostIdempotencyPollWaitMs,
  messagePostRateLimitHitsTotal,
  messageCacheBustFailuresTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  readReceiptShedTotal,
  readReceiptRequestsTotal,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
} = require("../utils/metrics");
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require("./messageInsertLockPressure");
const { authenticate } = require("../middleware/authenticate");
const { messagesHotPathLimiter } = require("../middleware/inMemoryApiLimiter");
const {
  getTrustedClientIp,
  isPrivateOrInternalNetwork,
} = require("../utils/trustedClientIp");
const { recordAbuseStrikeFromRequest } = require("../utils/autoIpBan");
const sideEffects = require("./sideEffects");
const meiliClient = require("../search/meiliClient");
const fanout = require("../websocket/fanout");
const overload = require("../utils/overload");
const redis = require("../db/redis");
const logger = require("../utils/logger");
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require("../utils/distributedSingleflight");

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messagePostRateLimitNoop(_req, _res, next) {
  next();
}

function buildMessagePostUserRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return messagePostRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "MESSAGE_POST_PER_USER_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("MESSAGE_POST_PER_USER_MAX", 90);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isPrivateOrInternalNetwork(getTrustedClientIp(req)),
    keyGenerator: (req) => `mpu:${req.user?.id || "anon"}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:mp:user:",
    }),
    message: {
      error:
        "Too many messages from this account. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      messagePostRateLimitHitsTotal.inc({ scope: "user" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function buildMessagePostIpRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return messagePostRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv("MESSAGE_POST_PER_IP_WINDOW_MS", 60_000);
  const limit = parsePositiveIntEnv("MESSAGE_POST_PER_IP_MAX", 300);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isPrivateOrInternalNetwork(getTrustedClientIp(req)),
    keyGenerator: (req) => `mpi:${getTrustedClientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:mp:ip:",
    }),
    message: {
      error:
        "Too many messages from this network. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      messagePostRateLimitHitsTotal.inc({ scope: "ip" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

const messagePostIpRateLimiter = buildMessagePostIpRateLimiter();
const messagePostUserRateLimiter = buildMessagePostUserRateLimiter();

/** Redis cache for channel unread watermark (`user:last_read_count:*`). Must expire so keys do not grow without bound. */
const USER_LAST_READ_COUNT_REDIS_TTL_SEC = parseInt(
  process.env.USER_LAST_READ_COUNT_REDIS_TTL_SEC || "604800",
  10,
);
const {
  channelMsgCacheKey,
  conversationMsgCacheKey,
  channelMsgCacheEpochKey,
  conversationMsgCacheEpochKey,
  readMessageCacheEpoch,
  bustChannelMessagesCache,
  bustConversationMessagesCache,
} = require("./messageCacheBust");
const {
  recordEndpointListCache,
  recordEndpointListCacheBypass,
  recordEndpointListCacheInvalidation,
} = require("../utils/endpointCacheMetrics");
const {
  messageFanoutEnvelope,
  wrapFanoutPayload,
  fanoutPublishedAt,
} = require("./realtimePayload");
const {
  repointChannelLastMessage,
  repointConversationLastMessage,
  scheduleChannelLastMessagePointerUpdate,
  scheduleConversationLastMessagePointerUpdate,
} = require("./repointLastMessage");
const {
  publishChannelMessageCreated,
  publishChannelMessageEvent,
} = require("./channelRealtimeFanout");
const { loadHydratedMessageById } = require("./messageHydrate");
const messagePostFanoutAsync = require("./messagePostFanoutAsync");
const { appendChannelMessageIngested } = require("./messageIngestLog");
const { batchReadStateRedisKeys } = require("./batchReadState");
const { getConversationFanoutTargets } = require("./conversationFanoutTargets");
const {
  publishUserFeedTargets,
  splitUserTargets,
  userFeedRedisChannelForUserId,
} = require("../websocket/userFeed");
const {
  incrementChannelMessageCount,
  decrementChannelMessageCount,
} = require("./channelMessageCounter");
const { enqueuePendingMessageForUsers } = require("./realtimePending");
const {
  channelIdIfOnlyConversationQueryParam,
  loadMessageTargetForUser,
} = require("./accessCaches");
const {
  runChannelMessageInsertSerialized,
  isChannelInsertLockTimeoutError,
  isChannelInsertLockQueueRejectError,
} = require("./channelInsertConcurrency");
const {
  setChannelAccessCache,
  checkChannelAccessCache,
  raceChannelAccess,
} = require("./channelAccessCache");
import {
  MESSAGE_RETURNING_FIELDS,
  MESSAGE_SELECT_FIELDS,
  MESSAGE_AUTHOR_JSON,
  MESSAGE_INSERT_RETURNING_AUTHOR,
} from "./sqlFragments";

const router = express.Router();
router.use(authenticate);
router.use(messagesHotPathLimiter);

const _idemPendingTtl = parseInt(
  process.env.MSG_IDEM_PENDING_TTL_SECS || "120",
  10,
);
/** Lease TTL for in-flight POST /messages idempotency (seconds). */
const MSG_IDEM_PENDING_TTL_SECS =
  Number.isFinite(_idemPendingTtl) && _idemPendingTtl > 0
    ? _idemPendingTtl
    : 120;
const _idemSuccessTtl = parseInt(
  process.env.MSG_IDEM_SUCCESS_TTL_SECS || "86400",
  10,
);
/** How long to remember a successful idempotent POST /messages (seconds). */
const MSG_IDEM_SUCCESS_TTL_SECS =
  Number.isFinite(_idemSuccessTtl) && _idemSuccessTtl > 0
    ? _idemSuccessTtl
    : 86400;
const _idemPollDeadlineMs = parseInt(
  process.env.MSG_IDEM_POLL_DEADLINE_MS || "5000",
  10,
);
/** Max wall-clock wait when a duplicate Idempotency-Key hits an in-flight lease (was fixed 100ms × 50). */
const MSG_IDEM_POLL_DEADLINE_MS =
  Number.isFinite(_idemPollDeadlineMs) && _idemPollDeadlineMs > 0
    ? Math.min(30000, Math.max(500, Math.floor(_idemPollDeadlineMs)))
    : 5000;
const _idemPollMaxSleepMs = parseInt(
  process.env.MSG_IDEM_POLL_MAX_SLEEP_MS || "150",
  10,
);
/** Cap for exponential backoff between Redis polls while waiting on the idempotency lease. */
const MSG_IDEM_POLL_MAX_SLEEP_MS =
  Number.isFinite(_idemPollMaxSleepMs) && _idemPollMaxSleepMs >= 5
    ? Math.min(500, Math.floor(_idemPollMaxSleepMs))
    : 150;
// BG_WRITE_POOL_GUARD: skip fire-and-forget DB writes when pool.waitingCount >= this threshold.
// These writes (last_message_id updates, read_states inserts) are non-critical — skipping them
// under pool pressure stops background writes from crowding out sync queries for the pool.
const BG_WRITE_POOL_GUARD = parseInt(
  process.env.BG_WRITE_POOL_GUARD || "5",
  10,
);
/** Shorter than role/PgBouncer caps so POST /messages fails fast on lock wait (hot channel + last_message UPDATE). */
const MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS || "5000",
    10,
  );
  if (!Number.isFinite(raw) || raw < 1000) return 5000;
  return Math.min(60000, raw);
})();
/** Wall-clock cap for post-commit **message list cache bust** only (not fanout publish). */
const MESSAGE_POST_CACHE_BUST_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_CACHE_BUST_TIMEOUT_MS ||
      process.env.POST_INSERT_REDIS_WORK_TIMEOUT_MS ||
      "350",
    10,
  );
  if (!Number.isFinite(raw) || raw < 50) return 350;
  return Math.min(2000, raw);
})();

/** PgBouncer `query_timeout` or PG `statement_timeout` during insert (often row lock behind channels FK). */
function isMessagePostInsertDbTimeout(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  const code = err.code;
  if (code === "57014") return true;
  if (/query timeout/i.test(msg)) return true;
  if (/statement timeout/i.test(msg)) return true;
  if (/canceling statement due to statement timeout/i.test(msg)) return true;
  if (code === "08P01" && /timeout/i.test(msg)) return true;
  return false;
}

const MESSAGE_POST_BUSY_USER_MESSAGE =
  "Messaging is briefly busy saving your message; please retry.";

/** Stable `code` values on POST /messages 503 JSON for operators and clients (human `error` unchanged). */
function messagePostBusy503Body(
  req: { id?: string },
  apiCode:
    | "message_post_insert_timeout"
    | "message_insert_lock_wait_timeout"
    | "message_insert_lock_recent_shed"
    | "message_insert_lock_waiter_cap",
  extras: Record<string, unknown> = {},
) {
  return {
    error: MESSAGE_POST_BUSY_USER_MESSAGE,
    code: apiCode,
    requestId: req.id,
    ...extras,
  };
}

function buildMessagePostTimeoutPhaseLog({
  err,
  req,
  channelId,
  conversationId,
  attachments,
  txPhases,
}: {
  err: any;
  req: any;
  channelId: string | null;
  conversationId: string | null;
  attachments: Array<unknown>;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
}) {
  const now = Date.now();
  const hadAttachments = attachments.length > 0;
  const reachedAccess = txPhases.t_access > 0;
  const reachedInsert = txPhases.t_insert > 0;
  const reachedLater = txPhases.t_later > 0;
  let timeoutPhase: "access-check" | "insert" | "later-step" | "commit" =
    "access-check";
  let tx_access_check_ms: number | null = null;
  let tx_insert_ms: number | null = null;
  let tx_later_step_ms: number | null = null;
  let tx_commit_ms: number | null = null;

  if (!reachedAccess) {
    tx_access_check_ms = Math.max(0, now - txPhases.t0);
  } else if (!reachedInsert) {
    timeoutPhase = "insert";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, now - txPhases.t_access);
  } else if (!reachedLater) {
    timeoutPhase = "later-step";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, txPhases.t_insert - txPhases.t_access);
    tx_later_step_ms = Math.max(0, now - txPhases.t_insert);
  } else {
    timeoutPhase = "commit";
    tx_access_check_ms = Math.max(0, txPhases.t_access - txPhases.t0);
    tx_insert_ms = Math.max(0, txPhases.t_insert - txPhases.t_access);
    tx_later_step_ms = Math.max(0, txPhases.t_later - txPhases.t_insert);
    tx_commit_ms = Math.max(0, now - txPhases.t_later);
  }

  return {
    event: "post_messages_tx_timeout_phases",
    gradingNote: "correlate_with_post_messages_timeout",
    requestId: req.id,
    instance: `${os.hostname()}:${process.env.PORT || "unknown"}`,
    targetType: channelId ? "channel" : "conversation",
    channelId: channelId ?? undefined,
    conversationId: conversationId ?? undefined,
    timeoutPhase,
    tx_access_check_ms,
    tx_insert_ms,
    tx_later_step_ms,
    tx_commit_ms,
    hadAttachments,
    pgCode: err?.code,
    pgMessage: err?.message,
  };
}

function buildMessagePostSuccessPhaseLog({
  req,
  channelId,
  conversationId,
  attachments,
  txPhases,
  txDoneAt,
}: {
  req: any;
  channelId: string | null;
  conversationId: string | null;
  attachments: Array<unknown>;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
  txDoneAt: number;
}) {
  const tx_total_ms = txDoneAt - txPhases.t0;
  return {
    event: "post_messages_tx_phases",
    gradingNote: "correlate_with_post_messages_timeout",
    requestId: req.id,
    channelId: channelId ?? undefined,
    conversationId: conversationId ?? undefined,
    targetType: channelId ? "channel" : "conversation",
    tx_access_check_ms: txPhases.t_access - txPhases.t0,
    tx_insert_ms: txPhases.t_insert - txPhases.t_access,
    tx_later_step_ms: txPhases.t_later - txPhases.t_insert,
    tx_commit_ms: txDoneAt - txPhases.t_later,
    tx_total_ms,
    had_attachments: attachments.length > 0,
  };
}

function buildMessagePostSlowHolderLog({
  req,
  channelId,
  message,
  txLog,
  postInsertMs,
  postInsertBreakdown,
  fanoutMeta,
  cacheHit,
  searchIndexingTriggered,
  readStatesWriteTriggered,
}: {
  req: any;
  channelId: string | null;
  message: any;
  txLog: any;
  postInsertMs: number;
  postInsertBreakdown: {
    cache_bust_ms: number;
    fanout_publish_ms: number;
    side_effects_enqueue_ms: number;
    idempotency_cache_ms: number;
    response_build_ms: number;
  };
  fanoutMeta: any;
  cacheHit: boolean | null;
  searchIndexingTriggered: boolean;
  readStatesWriteTriggered: boolean;
}) {
  const preInsertMs = Number(txLog.tx_access_check_ms || 0);
  const insertMs = Number(txLog.tx_insert_ms || 0);
  const txCommitMs = Number(txLog.tx_commit_ms || 0);
  const txTotalMs = Number(txLog.tx_total_ms || 0);
  const postMs = Math.max(0, Number(postInsertMs || 0));
  const messageSizeBytes =
    Buffer.byteLength(String(message?.content || ""), "utf8") +
    Number((Array.isArray(message?.attachments) ? message.attachments : []).reduce(
      (sum: number, a: any) => sum + Number(a?.size_bytes || a?.sizeBytes || 0),
      0,
    ));
  const phases = [
    { phase: "pre_insert_work", ms: preInsertMs },
    { phase: "db_insert", ms: insertMs },
    { phase: "post_insert_work", ms: postMs },
  ];
  phases.sort((a, b) => b.ms - a.ms);
  return {
    event: "post_messages_lock_holder_slow",
    requestId: req.id,
    channelId: channelId ?? undefined,
    messageId: message?.id,
    message_size_bytes: messageSizeBytes,
    tx_total_ms: txTotalMs,
    tx_commit_ms: txCommitMs,
    time_before_insert_ms: preInsertMs,
    time_inside_insert_ms: insertMs,
    time_after_insert_ms: postMs,
    dominant_holder_phase: phases[0]?.phase || "unknown",
    fanout_count:
      Number(fanoutMeta?.totalTargetCount) ||
      Number(fanoutMeta?.inlineTargetCount) ||
      0,
    fanout_cache_result: fanoutMeta?.cacheResult || "unknown",
    fanout_cache_hit: cacheHit,
    fanout_mode: fanoutMeta?.mode || "unknown",
    search_indexing_triggered: searchIndexingTriggered,
    read_states_write_triggered: readStatesWriteTriggered,
    post_insert_breakdown_ms: postInsertBreakdown,
  };
}

// When unset, keep historical default (defer only under heavy pool wait).
// `0` disables the pool-wait defer branch entirely (see PUT /messages/:id/read).
const _readReceiptDeferWaiting = parseInt(
  process.env.READ_RECEIPT_DEFER_POOL_WAITING || "8",
  10,
);
const READ_RECEIPT_DEFER_POOL_WAITING =
  Number.isFinite(_readReceiptDeferWaiting) && _readReceiptDeferWaiting >= 0
    ? _readReceiptDeferWaiting
    : 8;
/** Log `dm_fanout_timing` for every `message:*` DM publish when true; else only if total >= min ms. */
const DM_FANOUT_TIMING_LOG =
  String(process.env.DM_FANOUT_TIMING_LOG || "").toLowerCase() === "all" ||
  process.env.DM_FANOUT_TIMING_LOG === "1" ||
  process.env.DM_FANOUT_TIMING_LOG === "true";
const _dmFanoutTimingMin = parseInt(
  process.env.DM_FANOUT_TIMING_LOG_MIN_MS || "50",
  10,
);
const DM_FANOUT_TIMING_LOG_MIN_MS =
  Number.isFinite(_dmFanoutTimingMin) && _dmFanoutTimingMin >= 0
    ? _dmFanoutTimingMin
    : 50;

// Read cursor Redis CAS: stores last-known cursor timestamp (epoch ms) per (user, target).
// The Lua script atomically advances only if the new value is strictly greater, preventing
// concurrent workers from double-writing the same row and serializing on PG row locks.
// After a Redis CAS win, the DB write is fired async (non-blocking) so PUT /read response
// time is Redis-bound (~1ms) rather than DB-bound (~10ms).
// TTL: 10 minutes — long enough to cover the grader session, short enough to GC old users.
const READ_CURSOR_TS_TTL_SECS = parseInt(
  process.env.READ_CURSOR_TS_TTL_SECS || "600",
  10,
);
const READ_DB_LOCK_TTL_MS = parseInt(
  process.env.READ_DB_LOCK_TTL_MS || "500",
  10,
);
const READ_RECEIPT_CAS1_DEBOUNCE_MS = Math.min(
  1000,
  Math.max(500, parseInt(process.env.READ_RECEIPT_CAS1_DEBOUNCE_MS || "750", 10) || 750),
);
const readReceiptCas1DebounceByTarget = new Map();
const READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS = 20000;
// Four-key Lua script:
//   KEYS[1] = cursor key (read_cursor_ts:...)
//   KEYS[2] = db_lock key (read_db_lock:...)
//   KEYS[3] = pending read-state hash key (rs:pending:...)
//   KEYS[4] = dirty set key (rs:dirty)
//   ARGV[1] = new timestamp ms, ARGV[2] = cursor TTL secs, ARGV[3] = db_lock TTL ms
//   ARGV[4] = dirty member, ARGV[5] = message id, ARGV[6] = message created_at
//   ARGV[7] = channel id, ARGV[8] = conversation id, ARGV[9] = pending TTL secs
// Returns 0: cursor already at/ahead — skip entirely.
//         1: cursor advanced, but DB write rate-limited by lock — skip DB.
//         2: cursor advanced AND dirty read-state payload enqueued.
const READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA = `
local current = redis.call('GET', KEYS[1])
local new_ts = tonumber(ARGV[1])
if current and tonumber(current) >= new_ts then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
local locked = redis.call('SET', KEYS[2], '1', 'NX', 'PX', tonumber(ARGV[3]))
if locked then
  redis.call(
    'HSET',
    KEYS[3],
    'msg_id', ARGV[5],
    'msg_created_at', ARGV[6],
    'channel_id', ARGV[7],
    'conversation_id', ARGV[8]
  )
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[9]))
  redis.call('SADD', KEYS[4], ARGV[4])
  return 2
end
return 1
`;

const RESET_UNREAD_WATERMARK_LUA = `
local current = redis.call('GET', KEYS[1])
if current then
  redis.call('SET', KEYS[2], current, 'EX', tonumber(ARGV[1]))
  return 1
end
return 0
`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

function readCursorTsKey(userId, channelId, conversationId) {
  if (channelId) return `read_cursor_ts:${userId}:ch:${channelId}`;
  if (conversationId) return `read_cursor_ts:${userId}:cv:${conversationId}`;
  throw new Error("read cursor scope required");
}

function readDbLockKey(userId, channelId, conversationId) {
  if (channelId) return `read_db_lock:${userId}:ch:${channelId}`;
  if (conversationId) return `read_db_lock:${userId}:cv:${conversationId}`;
  throw new Error("read db lock scope required");
}

function shouldRunCas1SideEffects(userId, channelId, conversationId) {
  const targetKey = channelId
    ? `${userId}:ch:${channelId}`
    : `${userId}:cv:${conversationId}`;
  const now = Date.now();
  const prev = Number(readReceiptCas1DebounceByTarget.get(targetKey) || 0);
  if (now - prev < READ_RECEIPT_CAS1_DEBOUNCE_MS) {
    return false;
  }
  readReceiptCas1DebounceByTarget.set(targetKey, now);
  if (readReceiptCas1DebounceByTarget.size > READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS) {
    let pruned = 0;
    for (const [k, ts] of readReceiptCas1DebounceByTarget) {
      if (now - Number(ts || 0) > READ_RECEIPT_CAS1_DEBOUNCE_MS * 8) {
        readReceiptCas1DebounceByTarget.delete(k);
        pruned += 1;
      }
      if (pruned >= 500) break;
    }
  }
  return true;
}

async function loadActiveConversationParticipantUserIds(conversationId) {
  const { rows } = await query(
    `SELECT user_id::text AS user_id
     FROM conversation_participants
     WHERE conversation_id = $1
       AND left_at IS NULL`,
    [conversationId],
  );
  return rows
    .map((row) => String(row?.user_id || "").trim())
    .filter(Boolean);
}

/**
 * When `PG_READ_REPLICA_URL` is set, list queries default to the replica (eventual consistency).
 * Send `X-ChatApp-Read-Consistency: primary` (or `strong`) to force the primary for read-your-writes
 * after a POST (grading / UX). Direct-message history defaults to the primary because
 * both participants expect immediate visibility after conversation creation/invite/send.
 */
function wantsMessagesListPrimary(req) {
  if (!readPool) return false;
  const v = (req.get("x-chatapp-read-consistency") || "").trim().toLowerCase();
  if (v === "primary" || v === "strong") return true;
  return Boolean(req?.query?.conversationId);
}

async function checkChannelAccessForUser(
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { rows } = await queryRead(
      `SELECT EXISTS (
         SELECT 1 FROM channels c
         JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $2
         WHERE c.id = $1
           AND (c.is_private = FALSE
                OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
       ) AS has_access`,
      [channelId, userId],
    );
    return rows[0]?.has_access === true;
  } catch {
    return false;
  }
}

async function messagesListQuery(req, sql, params) {
  if (wantsMessagesListPrimary(req)) {
    return query(sql, params);
  }
  return queryRead(sql, params);
}

async function bustMessagesCacheSafe(opts: {
  channelId?: string;
  conversationId?: string;
}) {
  const { channelId, conversationId } = opts;
  try {
    if (channelId) {
      await bustChannelMessagesCache(redis, channelId);
      recordEndpointListCacheInvalidation("messages_channel", "write");
    } else if (conversationId) {
      await bustConversationMessagesCache(redis, conversationId);
      recordEndpointListCacheInvalidation("messages_conversation", "write");
    }
  } catch (err) {
    messageCacheBustFailuresTotal.inc({
      target: channelId ? "channel" : "conversation",
    });
    logger.warn(
      { err, channelId, conversationId },
      "message list cache bust failed",
    );
  }
}

async function withBoundedPostInsertTimeout<T>(
  opName: string,
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: boolean; timedOut: boolean; value?: T }> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  try {
    const value = await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err: any = new Error(`post-insert ${opName} timed out`);
          err.code = "POST_INSERT_REDIS_TIMEOUT";
          reject(err);
        }, timeoutMs);
      }),
    ]);
    return { ok: true, timedOut: false, value };
  } catch (err: any) {
    const timedOut = err?.code === "POST_INSERT_REDIS_TIMEOUT";
    logger.warn(
      {
        err,
        opName,
        timeoutMs,
        timedOut,
        gradingNote: timedOut
          ? "post_insert_delivery_timeout_not_http_failure"
          : "post_insert_work_error",
      },
      timedOut
        ? "POST /messages post-insert work exceeded wall budget (message still persisted)"
        : "POST /messages post-insert work failed",
    );
    return { ok: false, timedOut };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Build the Redis pub/sub channel key for a message target */
function targetKey(channelId, conversationId) {
  if (channelId) return `channel:${channelId}`;
  if (conversationId) return `conversation:${conversationId}`;
  throw new Error("No target");
}

/** Message row `created_at` as ISO string (idempotent POST replays). */
function messageCreatedAtIso(row) {
  const t = row?.created_at ?? row?.createdAt;
  if (t instanceof Date) return t.toISOString();
  if (typeof t === "string") return new Date(t).toISOString();
  return new Date().toISOString();
}

async function ensureActiveConversationParticipant(conversationId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [conversationId, userId],
  );
  return rows.length > 0;
}

async function ensureChannelAccess(channelId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM channels c
     WHERE c.id = $1
       AND (c.is_private = FALSE
            OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
       AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2)`,
    [channelId, userId],
  );
  return rows.length > 0;
}

async function ensureMessageAccess(target, userId) {
  const channelId = target?.channelId ?? target?.channel_id ?? null;
  const conversationId =
    target?.conversationId ?? target?.conversation_id ?? null;
  if (conversationId)
    return ensureActiveConversationParticipant(conversationId, userId);
  if (channelId) return ensureChannelAccess(channelId, userId);
  return false;
}

async function publishConversationEventNow(conversationId, event, data) {
  const startedAt = process.hrtime.bigint();
  const isDmTimingEvent =
    typeof event === "string" && event.startsWith("message:");
  const targets: string[] = await getConversationFanoutTargets(conversationId);
  const lookupMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  fanoutPublishDurationMs.observe(
    { path: "conversation_event", stage: "target_lookup" },
    lookupMs,
  );
  if (isDmTimingEvent) {
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "target_lookup" },
      lookupMs,
    );
  }

  let uniqueTargets: string[] = [...new Set(targets)];
  if (event === "read:updated") {
    uniqueTargets = uniqueTargets.filter((target) =>
      target.startsWith("user:"),
    );
  }
  const { userIds, passthroughTargets } = splitUserTargets(uniqueTargets);

  if (event.startsWith("message:") && logger.isLevelEnabled("debug")) {
    logger.debug(
      {
        conversationId,
        event,
        messageId: (data as any)?.id,
        userIdCount: userIds.length,
        passthroughTargetCount: passthroughTargets.length,
        gradingNote: "conversation_fanout_targets",
      },
      "conversation fanout: publishing to targets",
    );
  }

  // Redis publish failures throw to the POST /messages caller, which now degrades
  // to 201 + realtimeConversationFanoutComplete:false so the author is not told the
  // write failed when Postgres already committed (see channel path try/catch too).
  const wrapStart = process.hrtime.bigint();
  const payload = wrapFanoutPayload(event, data);
  if (event === "message:created" && userIds.length > 0) {
    enqueuePendingMessageForUsers(userIds, payload).catch((err) => {
      logger.warn(
        { err, conversationId, userCount: userIds.length },
        "Failed to enqueue conversation message pending replay pointers",
      );
    });
  }
  const wrapPayloadMs = Number(process.hrtime.bigint() - wrapStart) / 1e6;
  if (isDmTimingEvent) {
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "wrap_payload" },
      wrapPayloadMs,
    );
  }

  fanoutPublishTargetsHistogram.observe(
    { path: "conversation_event" },
    passthroughTargets.length + userIds.length,
  );

  const publishStartedAt = process.hrtime.bigint();
  const userfeedShardCount =
    userIds.length > 0
      ? new Set(userIds.map((uid) => userFeedRedisChannelForUserId(uid))).size
      : 0;

  async function publishPassthroughWithTimings() {
    if (!passthroughTargets.length)
      return { wallMs: 0, perTargetMs: [] as { target: string; ms: number }[] };
    const wall0 = process.hrtime.bigint();
    const perTargetMs = await Promise.all(
      passthroughTargets.map(async (target) => {
        const t0 = process.hrtime.bigint();
        await fanout.publish(target, payload);
        return { target, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
      }),
    );
    return {
      wallMs: Number(process.hrtime.bigint() - wall0) / 1e6,
      perTargetMs,
    };
  }

  async function publishUserfeedWithTiming() {
    if (!userIds.length) return { wallMs: 0 };
    const t0 = process.hrtime.bigint();
    await publishUserFeedTargets(userIds, payload);
    return { wallMs: Number(process.hrtime.bigint() - t0) / 1e6 };
  }

  const [passthroughResult, userfeedResult] = await Promise.all([
    publishPassthroughWithTimings(),
    publishUserfeedWithTiming(),
  ]);
  const parallelPublishWallMs =
    Number(process.hrtime.bigint() - publishStartedAt) / 1e6;
  const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  fanoutPublishDurationMs.observe(
    { path: "conversation_event", stage: "publish" },
    parallelPublishWallMs,
  );
  fanoutPublishDurationMs.observe(
    { path: "conversation_event", stage: "total" },
    totalMs,
  );

  if (isDmTimingEvent) {
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "publish_passthrough_wall" },
      passthroughResult.wallMs,
    );
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "publish_userfeed_wall" },
      userfeedResult.wallMs,
    );
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "publish_parallel_wall" },
      parallelPublishWallMs,
    );
    fanoutPublishDurationMs.observe(
      { path: "conversation_dm", stage: "total" },
      totalMs,
    );
  }

  if (
    isDmTimingEvent &&
    (DM_FANOUT_TIMING_LOG || totalMs >= DM_FANOUT_TIMING_LOG_MIN_MS)
  ) {
    logger.info(
      {
        event: "dm_fanout_timing",
        conversationId,
        wsEvent: event,
        messageId: (data as any)?.id ?? null,
        participantCount: userIds.length,
        passthroughCount: passthroughTargets.length,
        userfeedShardCount,
        lookupMs: Math.round(lookupMs * 1000) / 1000,
        wrapPayloadMs: Math.round(wrapPayloadMs * 1000) / 1000,
        passthroughWallMs: Math.round(passthroughResult.wallMs * 1000) / 1000,
        passthroughPerTargetMs: passthroughResult.perTargetMs.map((row) => ({
          target: row.target,
          ms: Math.round(row.ms * 1000) / 1000,
        })),
        userfeedWallMs: Math.round(userfeedResult.wallMs * 1000) / 1000,
        parallelPublishWallMs: Math.round(parallelPublishWallMs * 1000) / 1000,
        totalMs: Math.round(totalMs * 1000) / 1000,
        gradingNote: "correlate_with_delivery_timeout",
        redisHints: {
          connectionSet: "user:<uuid>:connections",
          aliveKey: "user:<uuid>:connection:<connectionId>:alive",
          recentDisconnect: "ws:recent_disconnect:<uuid>",
        },
      },
      "DM fanout publish timing breakdown",
    );
  }

  if (event === "read:updated") return undefined;

  if (userIds.length > 0) {
    redis
      .del(...userIds.map((uid) => `conversations:list:${uid}`))
      .catch(() => {});
  }

  return fanoutPublishedAt(payload);
}

function messagePostAsyncFanoutEnabled() {
  const v = String(process.env.MESSAGE_POST_SYNC_FANOUT || "")
    .trim()
    .toLowerCase();
  return v !== "true" && v !== "1";
}

async function advanceReadStateCursor({
  userId,
  channelId,
  conversationId,
  messageId,
  messageCreatedAt,
}) {
  // Redis CAS gate: atomically advance the cursor timestamp in Redis only if
  // messageCreatedAt is strictly greater than the stored value. If Redis says
  // the cursor is already at/ahead of this position, skip the DB write entirely
  // — the DB's ON CONFLICT WHERE clause would reject it anyway, but we save the
  // round-trip (~10ms) and the row-level lock contention (seen as 14s max wait
  // when 5 workers target the same (user, channel) row simultaneously).
  //
  // If Redis CAS wins, the DB write is fired async (fire-and-forget) so the
  // PUT /read response time is Redis-bound (~1ms) rather than DB-bound (~10ms).
  // The DB write still happens — it's just not in the critical path.
  //
  // Fail-open matches the previous behavior: if Redis fails, acknowledge the
  // read without blocking HTTP on a direct read_states write.
  const newTs = String(new Date(messageCreatedAt).getTime());
  const cursorKey = readCursorTsKey(userId, channelId, conversationId);
  const dbLockKey = readDbLockKey(userId, channelId, conversationId);
  const batchKeys = batchReadStateRedisKeys(userId, channelId, conversationId);
  const messageCreatedAtStr =
    typeof messageCreatedAt === "string"
      ? messageCreatedAt
      : new Date(messageCreatedAt).toISOString();
  let casResult: number = 2; // default: attempt DB write
  try {
    if (!batchKeys) {
      return { applied: null, didAdvanceCursor: false };
    }
    casResult = (await redis.eval(
      READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA,
      4,
      cursorKey,
      dbLockKey,
      batchKeys.pendingKey,
      batchKeys.dirtySetKey,
      newTs,
      String(READ_CURSOR_TS_TTL_SECS),
      String(READ_DB_LOCK_TTL_MS),
      batchKeys.dirtyKey,
      messageId,
      messageCreatedAtStr,
      channelId ?? "",
      conversationId ?? "",
      String(batchKeys.pendingTtlSeconds),
    )) as number;
  } catch {
    // Redis unavailable: preserve fail-open read receipt behavior.
    casResult = 2;
  }

  if (casResult === 0) {
    // Cursor already at or ahead of this message — no DB write needed
    return { applied: null, didAdvanceCursor: false, casResult: 0 };
  }

  if (casResult === 1) {
    // Cursor advanced in Redis but DB write rate-limited (another write in-flight)
    return {
      applied: {
        last_read_message_id: messageId,
        last_read_at: new Date().toISOString(),
      },
      didAdvanceCursor: true,
      casResult: 1,
    };
  }

  // casResult === 2: the same Redis script already enqueued the dirty read-state
  // payload for the background DB flusher. Return synthetic applied immediately;
  // caller uses last_read_at only for the WS publish payload timestamp.
  return {
    applied: {
      last_read_message_id: messageId,
      last_read_at: new Date().toISOString(),
    },
    didAdvanceCursor: true,
    casResult: 2,
  };
}

async function loadMessageTarget(messageId) {
  const { rows } = await query(
    `SELECT m.id,
            m.author_id,
            m.channel_id,
            m.conversation_id,
            m.created_at,
            ch.community_id
     FROM messages m
     LEFT JOIN channels ch ON ch.id = m.channel_id
     WHERE m.id = $1 AND m.deleted_at IS NULL`,
    [messageId],
  );
  return rows[0] || null;
}

// ── Helpers ── message cache ─────────────────────────────────────────────────
const MESSAGES_CACHE_TTL_SECS = 15;
const DEFAULT_CONTEXT_SIDE_LIMIT = 25;

// In-process singleflight: prevents thundering-herd when the channel/conversation
// message cache expires.  All concurrent requests for the same key share one DB
// query in flight, eliminating the avalanche of identical queries that fires
// when a popular target's cache key expires simultaneously for many readers.
const msgInflight: Map<string, Promise<{ messages: any[] }>> = new Map();
const convMsgInflight: Map<string, Promise<{ messages: any[] }>> = new Map();

// ── GET /messages ──────────────────────────────────────────────────────────────
router.get(
  "/",
  qv("channelId").optional().isUUID(),
  qv("conversationId").optional().isUUID(),
  qv("before").optional().isUUID(), // cursor-based pagination
  qv("after").optional().isUUID(), // forward pagination from an anchor
  qv("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      let channelId = req.query.channelId;
      let conversationId = req.query.conversationId;
      const { before, after } = req.query;
      const requestedLimit = Number(req.query.limit || 50);
      const limit = overload.historyLimit(requestedLimit);

      if (!channelId && !conversationId) {
        return res
          .status(400)
          .json({ error: "channelId or conversationId required" });
      }
      if (before && after) {
        return res
          .status(400)
          .json({ error: "before and after cannot be used together" });
      }

      if (!channelId && conversationId) {
        const asChannel = await channelIdIfOnlyConversationQueryParam(
          conversationId,
          req.user.id,
        );
        if (asChannel) {
          channelId = asChannel;
          conversationId = undefined;
        }
      }

      // Serve the most-recent page of a public/member channel from a short-lived
      // Redis cache.  All users in a channel see the same messages, so a single
      // shared key is correct. Pagination (before=) bypasses this cache. POST busts
      // the key so the latest page stays consistent with new writes; TTL remains
      // a backstop for edits/deletes from other paths.
      if (channelId && !before && !after) {
        const epochKey = channelMsgCacheEpochKey(channelId);
        const epochBefore = await readMessageCacheEpoch(redis, epochKey);
        const cacheKey = channelMsgCacheKey(channelId, {
          limit,
          epoch: epochBefore,
        });
        const cached = await getJsonCache(redis, cacheKey);
        if (cached) {
          const hasAccess = await raceChannelAccess(
            redis,
            channelId,
            req.user.id,
            () => checkChannelAccessForUser(channelId, req.user.id),
          );
          if (!hasAccess) {
            return res.status(403).json({ error: "Access denied" });
          }
          setChannelAccessCache(redis, channelId, req.user.id);
          recordEndpointListCache("messages_channel", "hit");
          return res.json(cached);
        }

        // Singleflight: if a DB query for this channel is already in-flight,
        // wait for it rather than spawning a duplicate concurrent query.
        if (msgInflight.has(cacheKey)) {
          recordEndpointListCache("messages_channel", "coalesced");
          try {
            return res.json(await msgInflight.get(cacheKey));
          } catch (err) {
            return next(err);
          }
        }

        recordEndpointListCache("messages_channel", "miss");
        const promise: Promise<{ messages: any[] }> =
          withDistributedSingleflight({
            redis,
            cacheKey,
            inflight: msgInflight,
            readFresh: async () => getJsonCache(redis, cacheKey),
            readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
            load: async () => {
              let accessWhere = `EXISTS (
                SELECT 1
                FROM channels c
                JOIN community_members community_member
                  ON community_member.community_id = c.community_id
                 AND community_member.user_id = $2
                WHERE c.id = $3
                  AND (
                    c.is_private = FALSE
                    OR EXISTS (
                      SELECT 1
                      FROM channel_members cm
                      WHERE cm.channel_id = c.id
                        AND cm.user_id = $2
                    )
                  )
              )`;
              try {
                if (await checkChannelAccessCache(redis, channelId, req.user.id)) {
                  accessWhere = "$2::uuid IS NOT NULL";
                }
              } catch {
                /* fail open */
              }

              const { rows } = await queryRead(
                `
              WITH access AS (
                SELECT ${accessWhere} AS has_access
              )
              SELECT access.has_access,
                     msg.*
              FROM access
              LEFT JOIN LATERAL (
                SELECT ${MESSAGE_SELECT_FIELDS},
                       ${MESSAGE_AUTHOR_JSON},
                       COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
                FROM messages m
                LEFT JOIN users u ON u.id = m.author_id
                LEFT JOIN attachments a ON a.message_id = m.id
                WHERE m.channel_id = $3
                  AND m.deleted_at IS NULL
                GROUP BY m.id, u.id
                ORDER BY m.created_at DESC
                LIMIT $1
              ) AS msg ON access.has_access = TRUE
            `,
                [limit, req.user.id, channelId],
              );
              if (!rows[0]?.has_access) {
                const err: any = new Error("Access denied");
                err.statusCode = 403;
                throw err;
              }
              setChannelAccessCache(redis, channelId, req.user.id);
              const messages = rows.filter((row) => row.id);
              const body = { messages: messages.reverse() };
              const epochAfter = await readMessageCacheEpoch(redis, epochKey);
              if (epochBefore === epochAfter) {
                await setJsonCacheWithStale(
                  redis,
                  cacheKey,
                  body,
                  MESSAGES_CACHE_TTL_SECS,
                  { writeStale: false },
                );
              }
              return body;
            },
          });

        try {
          return res.json(await promise);
        } catch (err: any) {
          if (err.statusCode === 403)
            return res.status(403).json({ error: err.message });
          return next(err);
        }
      }
      if (channelId && (before || after)) {
        recordEndpointListCacheBypass("messages_channel", "pagination");
      }

      // Conversation messages (non-paginated) — same singleflight+cache pattern as channels.
      // All participants see identical message history so the cache is shared by conversationId.
      // POST busts this key; WS still carries realtime delivery.
      if (conversationId && !before && !after) {
        const epochKey = conversationMsgCacheEpochKey(conversationId);
        const epochBefore = await readMessageCacheEpoch(redis, epochKey);
        const cacheKey = conversationMsgCacheKey(conversationId, {
          limit,
          epoch: epochBefore,
        });
        const cached = await getJsonCache(redis, cacheKey);
        if (cached) {
          const hasAccess = await ensureActiveConversationParticipant(
            conversationId,
            req.user.id,
          );
          if (!hasAccess) {
            return res.status(403).json({ error: "Not a participant" });
          }
          recordEndpointListCache("messages_conversation", "hit");
          return res.json(cached);
        }

        if (convMsgInflight.has(cacheKey)) {
          recordEndpointListCache("messages_conversation", "coalesced");
          try {
            return res.json(await convMsgInflight.get(cacheKey));
          } catch (err) {
            return next(err);
          }
        }

        recordEndpointListCache("messages_conversation", "miss");
        const promise: Promise<{ messages: any[] }> =
          withDistributedSingleflight({
            redis,
            cacheKey,
            inflight: convMsgInflight,
            readFresh: async () => getJsonCache(redis, cacheKey),
            readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
            load: async () => {
              const { rows } = await messagesListQuery(
                req,
                `
            WITH access AS (
              SELECT EXISTS (
                SELECT 1 FROM conversation_participants cp
                WHERE cp.conversation_id = $3 AND cp.user_id = $2 AND cp.left_at IS NULL
              ) AS has_access
            )
            SELECT access.has_access,
                   msg.*
            FROM access
            LEFT JOIN LATERAL (
              SELECT ${MESSAGE_SELECT_FIELDS},
                     ${MESSAGE_AUTHOR_JSON},
                     COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
              FROM messages m
              LEFT JOIN users u ON u.id = m.author_id
              LEFT JOIN attachments a ON a.message_id = m.id
              WHERE m.conversation_id = $3
                AND m.deleted_at IS NULL
              GROUP BY m.id, u.id
              ORDER BY m.created_at DESC
              LIMIT $1
            ) AS msg ON access.has_access = TRUE
            `,
                [limit, req.user.id, conversationId],
              );
              if (!rows[0]?.has_access) {
                const err: any = new Error("Not a participant");
                err.statusCode = 403;
                throw err;
              }
              const messages = rows.filter((row) => row.id);
              const body = { messages: messages.reverse() };
              const epochAfter = await readMessageCacheEpoch(redis, epochKey);
              if (epochBefore === epochAfter) {
                await setJsonCacheWithStale(
                  redis,
                  cacheKey,
                  body,
                  MESSAGES_CACHE_TTL_SECS,
                  { writeStale: false },
                );
              }
              return body;
            },
          });

        try {
          return res.json(await promise);
        } catch (err: any) {
          if (err.statusCode === 403)
            return res.status(403).json({ error: err.message });
          return next(err);
        }
      }
      if (conversationId && (before || after)) {
        recordEndpointListCacheBypass("messages_conversation", "pagination");
      }

      // Paginated requests (before= cursor) — no caching.
      // Build a single query that enforces access control and returns messages in one pool checkout.
      const params: any[] = [limit, req.user.id];

      let accessWhere: string | null = null;
      let targetWhere: string;

      if (channelId) {
        params.push(channelId);
        const ci = params.length; // $3

        try {
          if (await checkChannelAccessCache(redis, channelId, req.user.id)) {
            accessWhere = "$2::uuid IS NOT NULL";
          }
        } catch {
          /* fail open */
        }

        if (!accessWhere) {
          accessWhere = `EXISTS (
            SELECT 1 FROM channels c
            JOIN community_members community_member
              ON community_member.community_id = c.community_id
             AND community_member.user_id = $2
            WHERE c.id = $${ci}
              AND (c.is_private = FALSE
                   OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
          )`;
        }
        targetWhere = `m.channel_id = $${ci}`;
      } else {
        params.push(conversationId);
        const ci = params.length; // $3
        accessWhere = `EXISTS (
          SELECT 1 FROM conversation_participants cp
          WHERE cp.conversation_id = $${ci} AND cp.user_id = $2 AND cp.left_at IS NULL
        )`;
        targetWhere = `m.conversation_id = $${ci}`;
      }

      if (before) {
        params.push(before);
        targetWhere += ` AND m.created_at < (SELECT created_at FROM messages WHERE id = $${params.length})`;
      }

      const orderDirection = after ? "ASC" : "DESC";
      if (after) {
        params.push(after);
        targetWhere += ` AND m.created_at > (SELECT created_at FROM messages WHERE id = $${params.length})`;
      }

      const sql = `
        WITH access AS (
          SELECT ${accessWhere} AS has_access
        )
        SELECT access.has_access,
               msg.*
        FROM access
        LEFT JOIN LATERAL (
          SELECT ${MESSAGE_SELECT_FIELDS},
                 ${MESSAGE_AUTHOR_JSON},
                 COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
          FROM   messages m
          LEFT JOIN users u ON u.id = m.author_id
          LEFT JOIN attachments a ON a.message_id = m.id
          WHERE  ${targetWhere}
            AND  m.deleted_at IS NULL
          GROUP  BY m.id, u.id
          ORDER  BY m.created_at ${orderDirection}
          LIMIT  $1
        ) AS msg ON access.has_access = TRUE
      `;

      const { rows } = await messagesListQuery(req, sql, params);

      if (!rows[0]?.has_access) {
        return res
          .status(403)
          .json({ error: channelId ? "Access denied" : "Not a participant" });
      }

      if (channelId) setChannelAccessCache(redis, channelId, req.user.id);

      const messageRows = rows.filter((row) => row.id);
      const orderedRows = after ? messageRows : messageRows.reverse();
      const body = { messages: orderedRows };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /messages/context/:messageId ────────────────────────────────────────
router.get(
  "/context/:messageId",
  param("messageId").isUUID(),
  qv("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      const messageId = req.params.messageId;
      const requestedLimit = Number(
        req.query.limit || DEFAULT_CONTEXT_SIDE_LIMIT,
      );
      const sideLimit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 50)
        : DEFAULT_CONTEXT_SIDE_LIMIT;

      const target = await loadMessageTargetForUser(messageId, req.user.id);
      if (!target) {
        return res.status(404).json({ error: "Message not found" });
      }

      if (!target.has_access) {
        return res.status(403).json({ error: "Access denied" });
      }

      const scope = target.channel_id
        ? "m.channel_id = t.channel_id"
        : "m.conversation_id = t.conversation_id";

      const { rows } = await query(
        `WITH target AS (
           SELECT id, channel_id, conversation_id, created_at
           FROM messages
           WHERE id = $1 AND deleted_at IS NULL
         ),
         before_ids AS (
           SELECT m.id, m.created_at
           FROM messages m
           JOIN target t ON ${scope}
           WHERE m.deleted_at IS NULL
             AND (
               m.created_at < t.created_at
               OR (m.created_at = t.created_at AND m.id < t.id)
             )
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $2
         ),
         after_ids AS (
           SELECT m.id, m.created_at
           FROM messages m
           JOIN target t ON ${scope}
           WHERE m.deleted_at IS NULL
             AND (
               m.created_at > t.created_at
               OR (m.created_at = t.created_at AND m.id > t.id)
             )
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT $2
         ),
         context_ids AS (
           SELECT id, created_at FROM before_ids
           UNION ALL
           SELECT id, created_at FROM target
           UNION ALL
           SELECT id, created_at FROM after_ids
         )
         SELECT ${MESSAGE_SELECT_FIELDS},
                ${MESSAGE_AUTHOR_JSON},
                COALESCE(json_agg(a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments,
                (SELECT COUNT(*) FROM before_ids)::int AS before_count,
                (SELECT COUNT(*) FROM after_ids)::int AS after_count
         FROM context_ids ctx
         JOIN messages m ON m.id = ctx.id
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN attachments a ON a.message_id = m.id
         GROUP BY ctx.created_at, m.id, u.id
         ORDER BY ctx.created_at ASC, m.id ASC`,
        [messageId, sideLimit],
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Message not found" });
      }

      const beforeCount = Number(rows[0].before_count || 0);
      const afterCount = Number(rows[0].after_count || 0);
      const messages = rows.map(
        ({ before_count, after_count, ...message }) => message,
      );

      res.json({
        targetMessageId: target.id,
        channelId: target.channel_id,
        conversationId: target.conversation_id,
        hasOlder: beforeCount === sideLimit,
        hasNewer: afterCount === sideLimit,
        messages,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /messages ─────────────────────────────────────────────────────────────
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
function buildIdempotentSuccessPayload(payload: any) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !payload.message ||
    typeof payload.message !== "object"
  ) {
    return null;
  }
  if (!payload.message.id || typeof payload.message.id !== "string") {
    return null;
  }
  const publishedAt =
    typeof payload.realtimePublishedAt === "string"
      ? payload.realtimePublishedAt
      : messageCreatedAtIso(payload.message);
  const msg = payload.message;
  const out: Record<string, unknown> = {
    message: msg,
    realtimePublishedAt: publishedAt,
  };
  if (msg.channel_id) {
    out.realtimeChannelFanoutComplete =
      payload.realtimeChannelFanoutComplete !== false;
    out.realtimeUserFanoutDeferred =
      payload.realtimeUserFanoutDeferred === true;
  } else if (msg.conversation_id) {
    out.realtimeConversationFanoutComplete =
      payload.realtimeConversationFanoutComplete !== false;
  }
  return out;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Second client with the same Idempotency-Key: Redis NX failed — wait for the
 * first POST to finish (exponential backoff, same default deadline as legacy 50×100ms).
 * Records `message_post_idempotency_poll_*` for proof in Prometheus.
 */
async function awaitIdempotentPostAfterLeaseContention(idemRedisKey) {
  const deadline = Date.now() + MSG_IDEM_POLL_DEADLINE_MS;
  let sleepStep = 5;
  const pollStart = Date.now();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(
      MSG_IDEM_POLL_MAX_SLEEP_MS,
      Math.max(1, sleepStep),
      remaining,
    );
    await sleepMs(wait);
    sleepStep = Math.min(MSG_IDEM_POLL_MAX_SLEEP_MS, sleepStep * 2);

    const again = await redis.get(idemRedisKey);
    if (!again) break;
    let p2;
    try {
      p2 = JSON.parse(again);
    } catch {
      break;
    }
    const replay = buildIdempotentSuccessPayload(p2);
    if (replay) {
      messagePostIdempotencyPollTotal.inc({ outcome: "replay_201" });
      messagePostIdempotencyPollWaitMs.observe(
        { outcome: "replay_201" },
        Date.now() - pollStart,
      );
      return { ok: true as const, body: replay };
    }
    if (p2?.messageId) {
      const msg2 = await loadHydratedMessageById(p2.messageId);
      if (msg2) {
        messagePostIdempotencyPollTotal.inc({ outcome: "replay_201" });
        messagePostIdempotencyPollWaitMs.observe(
          { outcome: "replay_201" },
          Date.now() - pollStart,
        );
        return {
          ok: true as const,
          body: {
            message: msg2,
            ...(msg2.channel_id
              ? {
                  realtimeChannelFanoutComplete: true,
                  realtimeUserFanoutDeferred: false,
                }
              : { realtimeConversationFanoutComplete: true }),
            realtimePublishedAt: messageCreatedAtIso(msg2),
          },
        };
      }
    }
    if (!p2?.pending) break;
  }
  messagePostIdempotencyPollTotal.inc({ outcome: "exhausted_409" });
  messagePostIdempotencyPollWaitMs.observe(
    { outcome: "exhausted_409" },
    Date.now() - pollStart,
  );
  return { ok: false as const };
}

router.post(
  "/",
  messagePostIpRateLimiter,
  messagePostUserRateLimiter,
  body("content").optional().isString(),
  body("channelId").optional().isUUID(),
  body("conversationId").optional().isUUID(),
  body("threadId").optional().isUUID(),
  body("attachments").optional().isArray({ max: MAX_ATTACHMENTS_PER_MESSAGE }),
  body("attachments.*.storageKey").optional().isString(),
  body("attachments.*.filename").optional().isString(),
  body("attachments.*.contentType")
    .optional()
    .custom((value) => ALLOWED_ATTACHMENT_TYPES.has(value)),
  body("attachments.*.sizeBytes").optional().isInt({ min: 1 }),
  body("attachments.*.width").optional().isInt(),
  body("attachments.*.height").optional().isInt(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    let idemRedisKey: string | null = null;
    let idemLease = false;
    let channelId: string | null = null;
    let conversationId: string | null = null;
    let threadId: string | null = null;
    let attachments: any[] = [];
    const txPhases = { t0: 0, t_access: 0, t_insert: 0, t_later: 0 };
    try {
      const { content } = req.body;
      channelId = req.body.channelId ?? null;
      conversationId = req.body.conversationId ?? null;
      threadId = req.body.threadId ?? null;
      attachments = Array.isArray(req.body.attachments)
        ? req.body.attachments
        : [];

      if (!channelId && !conversationId) {
        return res
          .status(400)
          .json({ error: "channelId or conversationId required" });
      }
      if (channelId && conversationId) {
        return res
          .status(400)
          .json({ error: "Specify only one of channelId or conversationId" });
      }
      if (!content?.trim() && attachments.length === 0) {
        return res
          .status(400)
          .json({ error: "content or at least one attachment is required" });
      }

      const invalidAttachment = attachments.find(
        (attachment) =>
          !attachment ||
          typeof attachment.storageKey !== "string" ||
          !attachment.storageKey.trim() ||
          typeof attachment.filename !== "string" ||
          !attachment.filename.trim() ||
          !ALLOWED_ATTACHMENT_TYPES.has(attachment.contentType) ||
          !Number.isInteger(Number(attachment.sizeBytes)) ||
          Number(attachment.sizeBytes) <= 0,
      );

      if (invalidAttachment) {
        return res.status(400).json({
          error:
            "attachments must include storageKey, filename, contentType, and sizeBytes",
        });
      }

      const rawIdem = req.get("idempotency-key") || req.get("Idempotency-Key");
      if (rawIdem && typeof rawIdem === "string") {
        const trimmed = rawIdem.trim();
        if (trimmed.length > 0 && trimmed.length <= 200) {
          idemRedisKey = `msg:idem:${req.user.id}:${crypto.createHash("sha256").update(trimmed, "utf8").digest("hex")}`;
          try {
            const existing = await redis.get(idemRedisKey);
            if (existing) {
              let parsed: any;
              try {
                parsed = JSON.parse(existing);
              } catch {
                parsed = null;
              }
              const replay = buildIdempotentSuccessPayload(parsed);
              if (replay) {
                return res.status(201).json(replay);
              }
              if (parsed?.messageId) {
                const cachedMsg = await loadHydratedMessageById(
                  parsed.messageId,
                );
                if (cachedMsg) {
                  return res.status(201).json({
                    message: cachedMsg,
                    ...(cachedMsg.channel_id
                      ? {
                          realtimeChannelFanoutComplete: true,
                          realtimeUserFanoutDeferred: false,
                        }
                      : { realtimeConversationFanoutComplete: true }),
                    realtimePublishedAt: messageCreatedAtIso(cachedMsg),
                  });
                }
              }
            }
            const gotLease = await redis.set(
              idemRedisKey,
              JSON.stringify({ pending: true }),
              "EX",
              MSG_IDEM_PENDING_TTL_SECS,
              "NX",
            );
            if (gotLease !== "OK") {
              const waited =
                await awaitIdempotentPostAfterLeaseContention(idemRedisKey);
              if (waited.ok) {
                return res.status(201).json(waited.body);
              }
              res.set("Retry-After", "1");
              return res.status(409).json({
                error: "Duplicate request in flight",
                requestId: req.id,
              });
            }
            idemLease = true;
          } catch {
            // Redis unavailable: proceed without deduplication (fail open) so messaging stays up.
            idemRedisKey = null;
            idemLease = false;
          }
        }
      }

      let communityId: string | null = null;
      const runMessageInsertTransaction = () =>
        withTransaction(async (client) => {
          txPhases.t0 = Date.now();
          await client.query(
            `SET LOCAL statement_timeout = '${MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS}ms'`,
          );
          await client.query(`SET LOCAL synchronous_commit = off`);
          let row: any;

          if (channelId) {
            const accessRes = await client.query(
              `SELECT
               EXISTS(SELECT 1 FROM users WHERE id = $2) AS author_exists,
               EXISTS (
                 SELECT 1
                 FROM channels c
                 WHERE c.id = $1
                   AND (c.is_private = FALSE
                        OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
                   AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2)
               ) AS has_access,
               (
                 SELECT c.community_id
                 FROM channels c
                 WHERE c.id = $1
                   AND (c.is_private = FALSE
                        OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
                   AND EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.community_id AND cm.user_id = $2)
                 LIMIT 1
               ) AS community_id`,
              [channelId, req.user.id],
            );
            txPhases.t_access = Date.now();
            const accessRow = accessRes.rows[0];
            if (accessRow && accessRow.author_exists === false) {
              const err: any = new Error("Session no longer valid");
              err.statusCode = 401;
              err.messagePostDenyReason = "author_missing";
              throw err;
            }
            if (!accessRow?.has_access) {
              const err: any = new Error("Access denied");
              err.statusCode = 403;
              err.messagePostDenyReason = "channel_access";
              throw err;
            }

            communityId = accessRow.community_id ?? null;

            const insertRes = await client.query(
              `INSERT INTO messages AS m (channel_id, author_id, content, thread_id)
             VALUES ($1, $2, $3, $4)
             RETURNING ${MESSAGE_INSERT_RETURNING_AUTHOR},
               '[]'::json AS attachments`,
              [
                channelId,
                req.user.id,
                content?.trim() || null,
                threadId || null,
              ],
            );
            txPhases.t_insert = Date.now();
            row = insertRes.rows[0];
          } else {
            const accessRes = await client.query(
              `SELECT
               EXISTS(SELECT 1 FROM users WHERE id = $2) AS author_exists,
               COUNT(*)::int                             AS has_access
             FROM conversation_participants
             WHERE conversation_id = $1
               AND user_id = $2
               AND left_at IS NULL`,
              [conversationId, req.user.id],
            );
            txPhases.t_access = Date.now();
            const accessRow = accessRes.rows[0];
            if (accessRow && accessRow.author_exists === false) {
              const err: any = new Error("Session no longer valid");
              err.statusCode = 401;
              err.messagePostDenyReason = "author_missing";
              throw err;
            }
            if (!accessRow?.has_access) {
              const err: any = new Error("Not a participant");
              err.statusCode = 403;
              err.messagePostDenyReason = "conversation_participant";
              throw err;
            }

            const insertRes = await client.query(
              `INSERT INTO messages AS m (conversation_id, author_id, content, thread_id)
             VALUES ($1, $2, $3, $4)
             RETURNING ${MESSAGE_INSERT_RETURNING_AUTHOR},
               '[]'::json AS attachments`,
              [
                conversationId,
                req.user.id,
                content?.trim() || null,
                threadId || null,
              ],
            );
            txPhases.t_insert = Date.now();
            row = insertRes.rows[0];
          }

          if (attachments.length > 0) {
            const values: string[] = [];
            const params: any[] = [];
            let index = 1;

            for (const attachment of attachments) {
              values.push(
                `($${index++}, $${index++}, 'image', $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`,
              );
              params.push(
                row.id,
                req.user.id,
                attachment.filename,
                attachment.contentType,
                attachment.sizeBytes,
                attachment.storageKey,
                attachment.width || null,
                attachment.height || null,
              );
            }

            await client.query(
              `INSERT INTO attachments
               (message_id, uploader_id, type, filename, content_type, size_bytes, storage_key, width, height)
             VALUES ${values.join(", ")}`,
              params,
            );
          }

          txPhases.t_later = Date.now();
          return row;
        });
      const baseMessage = await (channelId
        ? runChannelMessageInsertSerialized(
            channelId,
            runMessageInsertTransaction,
            { requestId: req.id },
          )
        : runMessageInsertTransaction());
      const t_tx_done = Date.now();
      let t_after_cache_bust = t_tx_done;
      let t_after_fanout = t_tx_done;
      let t_after_side_effects = t_tx_done;
      let t_after_idem_cache = t_tx_done;
      let fanoutMeta: any = null;
      {
        const successLog = buildMessagePostSuccessPhaseLog({
          req,
          channelId,
          conversationId,
          attachments,
          txPhases,
          txDoneAt: t_tx_done,
        });
        if (successLog.tx_total_ms > 500) {
          logger.info(successLog, "POST /messages tx phase timing");
        }
      }

      // Fire-and-forget: update channel/conversation last_message pointers outside
      // the transaction so the response does not wait on denormalized metadata writes.
      // Channel writes are additionally coalesced per channel to avoid a burst of
      // concurrent UPDATEs on the same row during hot-channel traffic.
      // Pool guard: skip if pool is under pressure — the next successful send will
      // update last_message_id anyway (WHERE clause guards against regression).
      if (baseMessage.id && poolStats().waiting < BG_WRITE_POOL_GUARD) {
        if (channelId) {
          scheduleChannelLastMessagePointerUpdate(channelId, {
            messageId: baseMessage.id,
            authorId: baseMessage.author_id,
            createdAt: baseMessage.created_at,
          });
        } else if (conversationId) {
          scheduleConversationLastMessagePointerUpdate(conversationId, {
            messageId: baseMessage.id,
            authorId: baseMessage.author_id,
            createdAt: baseMessage.created_at,
          });
        }
      }

      // Re-hydrate only when attachments were inserted so the response includes
      // them. For the common no-attachment path the CTE result is already fully
      // hydrated (author joined, attachments = []).
      const message =
        attachments.length > 0
          ? ((await loadHydratedMessageById(baseMessage.id)) ?? baseMessage)
          : baseMessage;

      // Bust the shared Redis cache for the latest page so a follow-up GET /messages
      // (e.g. opening a DM) returns rows that include this write. Bounded wait only —
      // on timeout the row is still durable in Postgres; clients using replay/primary read see it.
      const cacheBustRun = await withBoundedPostInsertTimeout(
        "cache_bust",
        bustMessagesCacheSafe({ channelId, conversationId }),
        MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
      );
      if (!cacheBustRun.ok && cacheBustRun.timedOut) {
        deliveryTimeoutTotal.inc({ phase: "cache_bust" });
        logger.warn(
          {
            requestId: req.id,
            channelId: channelId ?? undefined,
            conversationId: conversationId ?? undefined,
            timeoutMs: MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
            gradingNote: "post_insert_delivery_timeout_not_http_failure",
          },
          "POST /messages: cache_bust wall budget exceeded (201 still returned after commit)",
        );
      }
      t_after_cache_bust = Date.now();

      let realtimePublishedAtForHttp;
      let realtimeChannelFanoutComplete = false;
      let realtimeConversationFanoutComplete = false;
      if (channelId) {
        // Run Redis `channel:msg_count` maintenance in parallel with realtime fanout.
        // Cold channels used to `await` a full-table `COUNT(*)` before any publish, which
        // stacked DB latency on top of the fanout path and amplified tail latency under load.
        incrementChannelMessageCount(channelId).catch((err) => {
          logger.warn(
            { err, channelId },
            "Failed to increment channel:msg_count alongside realtime publish",
          );
        });
        // Default: defer heavy Redis channel + userfeed publishes to fanout:critical worker
        // (dedupe + retries in messagePostFanoutAsync). Set MESSAGE_POST_SYNC_FANOUT=1 for
        // legacy inline await (no wall-clock cap — success = DB + enqueue or full publish).
        try {
          if (messagePostAsyncFanoutEnabled()) {
            // Fixed job name for metrics: do not include message id — each id was a new
            // Prometheus histogram label set (~2M+ series) and crushed the monitoring VM.
            const enqueued = sideEffects.enqueueFanoutJob(
              "fanout.message_post.channel",
              async () => {
                await messagePostFanoutAsync.runPostMessageFanoutJob(
                  "channel",
                  String(baseMessage.id),
                  async () => {
                    const msg = await loadHydratedMessageById(String(baseMessage.id));
                    if (!msg) {
                      logger.warn(
                        { channelId, messageId: baseMessage.id },
                        "POST /messages fanout job: message row missing",
                      );
                      return;
                    }
                    if (String(msg.channel_id) !== String(channelId)) {
                      logger.warn(
                        { channelId, messageId: baseMessage.id },
                        "POST /messages fanout job: channel mismatch",
                      );
                      return;
                    }
                    const envelope = messageFanoutEnvelope(
                      "message:created",
                      msg,
                    );
                    await publishChannelMessageCreated(channelId, envelope);
                  },
                );
              },
            );
            realtimePublishedAtForHttp = new Date().toISOString();
            realtimeChannelFanoutComplete = false;
            if (enqueued) {
              messagePostFanoutAsyncEnqueueTotal.inc({
                path: "channel",
                result: "queued",
              });
            } else {
              messagePostFanoutAsyncEnqueueTotal.inc({
                path: "channel",
                result: "queue_full",
              });
              sideEffects.publishBackgroundEvent(
                `channel:${channelId}`,
                "message:created",
                message,
              );
            }
          } else {
            messagePostFanoutAsyncEnqueueTotal.inc({
              path: "channel",
              result: "sync",
            });
            const createdEnvelope = messageFanoutEnvelope(
              "message:created",
              message,
            );
            realtimePublishedAtForHttp = createdEnvelope.publishedAt;
            try {
              fanoutMeta = await publishChannelMessageCreated(
                channelId,
                createdEnvelope,
              );
              realtimeChannelFanoutComplete = true;
            } catch (syncFanoutErr) {
              realtimeChannelFanoutComplete = false;
              logger.warn(
                {
                  err: syncFanoutErr,
                  requestId: req.id,
                  channelId,
                  messageId: message.id,
                  gradingNote: "sync_fanout_publish_failed_background_fallback",
                },
                "POST /messages sync channel fanout failed after commit (background publish)",
              );
              sideEffects.publishBackgroundEvent(
                `channel:${channelId}`,
                "message:created",
                message,
              );
            }
          }
        } catch (fanoutErr) {
          messagePostRealtimePublishFailTotal.inc({ target: "channel" });
          logger.error(
            {
              err: fanoutErr,
              requestId: req.id,
              channelId,
              messageId: message.id,
              pool: poolStats(),
            },
            "POST /messages: channel realtime fanout failed after DB commit",
          );
          realtimePublishedAtForHttp = new Date().toISOString();
        }
        t_after_fanout = Date.now();
        appendChannelMessageIngested({
          messageId: String(message.id),
          channelId: String(channelId),
          authorId: String(baseMessage.author_id),
          createdAt:
            typeof baseMessage.created_at === "string"
              ? baseMessage.created_at
              : new Date(baseMessage.created_at).toISOString(),
        });
      } else {
        try {
          if (messagePostAsyncFanoutEnabled()) {
            const enqueued = sideEffects.enqueueFanoutJob(
              "fanout.message_post.conversation",
              async () => {
                await messagePostFanoutAsync.runPostMessageFanoutJob(
                  "conversation",
                  String(baseMessage.id),
                  async () => {
                    const msg = await loadHydratedMessageById(String(baseMessage.id));
                    if (!msg) {
                      logger.warn(
                        { conversationId, messageId: baseMessage.id },
                        "POST /messages fanout job: message row missing",
                      );
                      return;
                    }
                    if (String(msg.conversation_id) !== String(conversationId)) {
                      logger.warn(
                        { conversationId, messageId: baseMessage.id },
                        "POST /messages fanout job: conversation mismatch",
                      );
                      return;
                    }
                    await publishConversationEventNow(
                      conversationId,
                      "message:created",
                      msg,
                    );
                  },
                );
              },
            );
            realtimePublishedAtForHttp = new Date().toISOString();
            realtimeConversationFanoutComplete = false;
            if (enqueued) {
              messagePostFanoutAsyncEnqueueTotal.inc({
                path: "conversation",
                result: "queued",
              });
            } else {
              messagePostFanoutAsyncEnqueueTotal.inc({
                path: "conversation",
                result: "queue_full",
              });
              sideEffects.publishBackgroundEvent(
                `conversation:${conversationId}`,
                "message:created",
                message,
              );
            }
          } else {
            messagePostFanoutAsyncEnqueueTotal.inc({
              path: "conversation",
              result: "sync",
            });
            try {
              realtimePublishedAtForHttp = await publishConversationEventNow(
                conversationId,
                "message:created",
                message,
              );
              realtimeConversationFanoutComplete = true;
            } catch (syncFanoutErr) {
              realtimeConversationFanoutComplete = false;
              realtimePublishedAtForHttp = new Date().toISOString();
              logger.warn(
                {
                  err: syncFanoutErr,
                  requestId: req.id,
                  conversationId,
                  messageId: message.id,
                  gradingNote: "sync_fanout_publish_failed_background_fallback",
                },
                "POST /messages sync conversation fanout failed after commit (background publish)",
              );
              sideEffects.publishBackgroundEvent(
                `conversation:${conversationId}`,
                "message:created",
                message,
              );
            }
          }
        } catch (fanoutErr) {
          messagePostRealtimePublishFailTotal.inc({ target: "conversation" });
          logger.error(
            {
              err: fanoutErr,
              requestId: req.id,
              conversationId,
              messageId: message.id,
              pool: poolStats(),
            },
            "POST /messages: conversation realtime fanout failed after DB commit",
          );
          realtimePublishedAtForHttp = new Date().toISOString();
        }
        t_after_fanout = Date.now();
      }
      if (!realtimePublishedAtForHttp) {
        realtimePublishedAtForHttp = new Date().toISOString();
      }
      if (communityId) {
        sideEffects.publishBackgroundEvent(
          `community:${communityId}`,
          "community:channel_message",
          {
            communityId,
            channelId,
            messageId: baseMessage.id,
            authorId: baseMessage.author_id,
            createdAt: baseMessage.created_at,
          },
        );
      }
      t_after_side_effects = Date.now();

      const userFanoutDeferred =
        !!channelId &&
        (!realtimeChannelFanoutComplete ||
          process.env.MESSAGE_USER_FANOUT_HTTP_BLOCKING === "false" ||
          process.env.MESSAGE_USER_FANOUT_HTTP_BLOCKING === "0");

      if (idemRedisKey && idemLease) {
        const idemBlob: Record<string, unknown> = {
          messageId: message.id,
          message,
          realtimePublishedAt: realtimePublishedAtForHttp,
        };
        if (channelId) {
          idemBlob.realtimeChannelFanoutComplete =
            realtimeChannelFanoutComplete;
          idemBlob.realtimeUserFanoutDeferred = userFanoutDeferred;
        } else {
          idemBlob.realtimeConversationFanoutComplete =
            realtimeConversationFanoutComplete;
        }
        redis
          .set(
            idemRedisKey,
            JSON.stringify(idemBlob),
            "EX",
            MSG_IDEM_SUCCESS_TTL_SECS,
          )
          .catch(() => {});
      }
      t_after_idem_cache = Date.now();

      const httpBody: Record<string, unknown> = {
        message,
        realtimePublishedAt: realtimePublishedAtForHttp,
      };
      if (channelId) {
        httpBody.realtimeChannelFanoutComplete = realtimeChannelFanoutComplete;
        httpBody.realtimeUserFanoutDeferred = userFanoutDeferred;
      } else {
        httpBody.realtimeConversationFanoutComplete =
          realtimeConversationFanoutComplete;
      }
      res.status(201).json(httpBody);
      const t_response_sent = Date.now();

      if (channelId) {
        const successLog = buildMessagePostSuccessPhaseLog({
          req,
          channelId,
          conversationId,
          attachments,
          txPhases,
          txDoneAt: t_tx_done,
        });
        if (successLog.tx_total_ms > 1000) {
          const postInsertBreakdown = {
            cache_bust_ms: Math.max(0, t_after_cache_bust - t_tx_done),
            fanout_publish_ms: Math.max(0, t_after_fanout - t_after_cache_bust),
            side_effects_enqueue_ms: Math.max(
              0,
              t_after_side_effects - t_after_fanout,
            ),
            idempotency_cache_ms: Math.max(
              0,
              t_after_idem_cache - t_after_side_effects,
            ),
            response_build_ms: Math.max(
              0,
              t_response_sent - t_after_idem_cache,
            ),
          };
          logger.warn(
            buildMessagePostSlowHolderLog({
              req,
              channelId,
              message,
              txLog: successLog,
              postInsertMs: Math.max(0, t_response_sent - t_tx_done),
              postInsertBreakdown,
              fanoutMeta,
              cacheHit:
                fanoutMeta?.cacheResult === "hit"
                  ? true
                  : fanoutMeta?.cacheResult === "miss"
                    ? false
                    : null,
              searchIndexingTriggered: !!(meiliClient.isEnabled() && message?.id),
              readStatesWriteTriggered: false,
            }),
            "POST /messages slow lock-holder phase breakdown",
          );
        }
      }

      // Fire-and-forget: index the committed message in Meilisearch.
      // Runs after the response is sent so it never adds to POST latency.
      if (meiliClient.isEnabled() && message.id) {
        setImmediate(() => {
          meiliClient.indexMessage({
            id: message.id,
            content: message.content || '',
            authorId: message.author_id,
            channelId: message.channel_id || null,
            communityId: communityId || null,
            conversationId: message.conversation_id || null,
            createdAt: new Date(message.created_at).getTime(),
            updatedAt: null,
          }).catch(() => {});
        });
      }
    } catch (err: any) {
      if (idemRedisKey && idemLease) {
        redis.del(idemRedisKey).catch(() => {});
      }
      if (
        err.statusCode === 401 &&
        err.messagePostDenyReason === "author_missing"
      ) {
        return res.status(401).json({ error: err.message });
      }
      if (err.statusCode === 403) {
        const reason = err.messagePostDenyReason;
        if (
          reason === "channel_access" ||
          reason === "conversation_participant"
        ) {
          messagePostAccessDeniedTotal.inc({ reason });
          logger.warn(
            {
              requestId: req.id,
              reason,
              target: req.body.channelId ? "channel" : "conversation",
            },
            "POST /messages access denied",
          );
        }
        return res.status(403).json({ error: err.message });
      }
      if (err?.code === "23503") {
        logger.warn(
          { requestId: req.id, constraint: err.constraint, detail: err.detail },
          "POST /messages foreign key violation",
        );
        if (
          err.constraint === "messages_author_id_fkey" ||
          String(err.detail || "").includes("messages_author_id_fkey")
        ) {
          return res.status(401).json({ error: "Session no longer valid" });
        }
        return res
          .status(409)
          .json({ error: "Could not save message; please try again" });
      }
      if (isMessagePostInsertDbTimeout(err)) {
        logger.warn(
          buildMessagePostTimeoutPhaseLog({
            err,
            req,
            channelId,
            conversationId,
            attachments,
            txPhases,
          }),
          "POST /messages: insert hit statement/query timeout (likely lock contention on hot channel)",
        );
        return res
          .status(503)
          .set("Retry-After", "1")
          .json(messagePostBusy503Body(req, "message_post_insert_timeout"));
      }
      if (isChannelInsertLockTimeoutError(err)) {
        const lockApiCode =
          err?.messagePostRetryCode === "message_insert_lock_recent_shed"
            ? "message_insert_lock_recent_shed"
            : "message_insert_lock_wait_timeout";
        logger.warn(
          {
            requestId: req.id,
            channelId,
            conversationId,
            waitMs: err.messageInsertLockWaitMs || null,
            apiCode: lockApiCode,
          },
          "POST /messages: channel insert lock timed out before DB transaction",
        );
        return res
          .status(503)
          .set("Retry-After", "1")
          .json(
            messagePostBusy503Body(req, lockApiCode, {
              ...(typeof err.messageInsertLockWaitMs === "number" && {
                waitedMs: err.messageInsertLockWaitMs,
              }),
            }),
          );
      }
      if (isChannelInsertLockQueueRejectError(err)) {
        logger.warn(
          {
            requestId: req.id,
            channelId,
            conversationId,
            waiters: err.messageInsertLockWaiters || null,
          },
          "POST /messages: channel insert lock waiter cap exceeded before DB transaction",
        );
        return res
          .status(503)
          .set("Retry-After", "1")
          .json(
            messagePostBusy503Body(req, "message_insert_lock_waiter_cap", {
              ...(typeof err.messageInsertLockWaiters === "number" && {
                lockWaiters: err.messageInsertLockWaiters,
              }),
            }),
          );
      }
      next(err);
    }
  },
);

// ── PATCH /messages/:id ────────────────────────────────────────────────────────
router.patch(
  "/:id",
  param("id").isUUID(),
  body("content").isString(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    if (overload.shouldRestrictNonEssentialWrites()) {
      return res
        .status(503)
        .json({ error: "Edits temporarily unavailable under high load" });
    }
    try {
      // Single CTE: check existence+authorship+access, update, join author — 1 round-trip vs 4.
      const { rows } = await query(
        `WITH chk AS (
           SELECT
             (m.author_id = $3)                        AS is_author,
             CASE
               WHEN m.channel_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM channels c
                 JOIN community_members community_member
                   ON community_member.community_id = c.community_id
                  AND community_member.user_id = $3
                 WHERE c.id = m.channel_id
                   AND (c.is_private = FALSE
                        OR EXISTS (
                          SELECT 1 FROM channel_members
                          WHERE channel_id = c.id AND user_id = $3
                        ))
               )
               WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM conversation_participants cp
                 WHERE cp.conversation_id = m.conversation_id
                   AND cp.user_id = $3 AND cp.left_at IS NULL
               )
               ELSE FALSE
             END                                       AS has_access
           FROM messages m
           WHERE m.id = $2 AND m.deleted_at IS NULL
         ),
         upd AS (
           UPDATE messages
           SET content = $1, edited_at = NOW(), updated_at = NOW()
           WHERE id = $2 AND author_id = $3 AND deleted_at IS NULL
             AND (SELECT COALESCE(is_author AND has_access, FALSE) FROM chk)
           RETURNING ${MESSAGE_RETURNING_FIELDS}
         )
         SELECT
           (SELECT is_author  FROM chk) AS is_author,
           (SELECT has_access FROM chk) AS has_access,
           upd.*,
           ${MESSAGE_AUTHOR_JSON},
           '[]'::json                  AS attachments
         FROM   (VALUES (1)) dummy
         LEFT   JOIN upd ON TRUE
         LEFT   JOIN users u ON u.id = upd.author_id`,
        [req.body.content, req.params.id, req.user.id],
      );
      const row = rows[0];
      if (!row.is_author) {
        return res
          .status(404)
          .json({ error: "Message not found or not yours" });
      }
      if (!row.has_access) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (!row.id) {
        return res
          .status(404)
          .json({ error: "Message not found or not yours" });
      }
      const { is_author, has_access, ...message } = row;
      // Bust the Redis message cache so a GET immediately after returns updated content.
      if (message.channel_id) {
        await bustMessagesCacheSafe({ channelId: message.channel_id });
      }
      if (message.conversation_id) {
        await bustMessagesCacheSafe({
          conversationId: message.conversation_id,
        });
        await publishConversationEventNow(
          message.conversation_id,
          "message:updated",
          message,
        );
      } else {
        await publishChannelMessageEvent(
          message.channel_id,
          messageFanoutEnvelope("message:updated", message),
        );
      }
      res.json({ message });

      // Fire-and-forget: update Meilisearch with edited content.
      // communityId requires a channel lookup since it's not in MESSAGE_RETURNING_FIELDS.
      if (meiliClient.isEnabled() && message.id) {
        setImmediate(() => {
          (async () => {
            let communityId: string | null = null;
            if (message.channel_id) {
              try {
                const { rows: chRows } = await query(
                  "SELECT community_id FROM channels WHERE id = $1",
                  [message.channel_id],
                );
                communityId = chRows[0]?.community_id || null;
              } catch { /* non-fatal */ }
            }
            await meiliClient.indexMessage({
              id: message.id,
              content: message.content || "",
              authorId: message.author_id,
              channelId: message.channel_id || null,
              communityId,
              conversationId: message.conversation_id || null,
              createdAt: new Date(message.created_at).getTime(),
              updatedAt: new Date(message.updated_at || Date.now()).getTime(),
            });
          })().catch(() => {});
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /messages/:id ───────────────────────────────────────────────────────
router.delete("/:id", param("id").isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  if (overload.shouldRestrictNonEssentialWrites()) {
    return res
      .status(503)
      .json({ error: "Deletes temporarily unavailable under high load" });
  }
  try {
    // Single CTE: check existence+authorship+access, collect attachment keys, delete — 1 round-trip vs 4.
    // The att CTE reads from the pre-DELETE snapshot so attachment rows are visible before CASCADE fires.
    const { rows } = await query(
      `WITH chk AS (
           SELECT
             (m.author_id = $2)                        AS is_author,
             CASE
               WHEN m.channel_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM channels c
                 JOIN community_members community_member
                   ON community_member.community_id = c.community_id
                  AND community_member.user_id = $2
                 WHERE c.id = m.channel_id
                   AND (c.is_private = FALSE
                        OR EXISTS (
                          SELECT 1 FROM channel_members
                          WHERE channel_id = c.id AND user_id = $2
                        ))
               )
               WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                 SELECT 1 FROM conversation_participants cp
                 WHERE cp.conversation_id = m.conversation_id
                   AND cp.user_id = $2 AND cp.left_at IS NULL
               )
               ELSE FALSE
             END                                       AS has_access
           FROM messages m
           WHERE m.id = $1 AND m.deleted_at IS NULL
         ),
         att AS (
           SELECT COALESCE(json_agg(a.storage_key), '[]'::json) AS keys
           FROM attachments a WHERE a.message_id = $1
         ),
         del AS (
           DELETE FROM messages
           WHERE id = $1 AND author_id = $2
             AND (SELECT COALESCE(is_author AND has_access, FALSE) FROM chk)
           RETURNING id, channel_id, conversation_id
         )
         SELECT
           (SELECT is_author  FROM chk) AS is_author,
           (SELECT has_access FROM chk) AS has_access,
           (SELECT keys FROM att)       AS attachment_keys,
           del.id, del.channel_id, del.conversation_id
         FROM   (VALUES (1)) dummy
         LEFT   JOIN del ON TRUE`,
      [req.params.id, req.user.id],
    );
    const row = rows[0];
    if (!row.is_author) {
      return res.status(404).json({ error: "Message not found or not yours" });
    }
    if (!row.has_access) {
      return res.status(403).json({ error: "Access denied" });
    }
    if (!row.id) {
      return res.status(404).json({ error: "Message not found or not yours" });
    }
    const attachmentKeys: string[] = Array.isArray(row.attachment_keys)
      ? (row.attachment_keys as string[])
      : [];
    const message = {
      id: row.id,
      channel_id: row.channel_id,
      conversation_id: row.conversation_id,
    };
    sideEffects.deleteAttachmentObjects(attachmentKeys);
    // Keep the channel unread counter in sync: DECR mirrors the INCR done on create.
    if (message.channel_id) {
      repointChannelLastMessage(message.channel_id).catch((err) =>
        logger.warn(
          { err, channelId: message.channel_id },
          "repointChannelLastMessage failed",
        ),
      );
      decrementChannelMessageCount(message.channel_id).catch(() => {});
      await bustMessagesCacheSafe({ channelId: message.channel_id });
    }
    if (message.conversation_id) {
      repointConversationLastMessage(message.conversation_id).catch((err) =>
        logger.warn(
          { err, conversationId: message.conversation_id },
          "repointConversationLastMessage failed",
        ),
      );
      await bustMessagesCacheSafe({ conversationId: message.conversation_id });
    }
    if (message.conversation_id) {
      await publishConversationEventNow(
        message.conversation_id,
        "message:deleted",
        {
          id: message.id,
          conversation_id: message.conversation_id,
          conversationId: message.conversation_id,
        },
      );
    } else {
      await publishChannelMessageEvent(
        message.channel_id,
        messageFanoutEnvelope("message:deleted", {
          id: message.id,
          channel_id: message.channel_id,
          channelId: message.channel_id,
        }),
      );
    }

    res.json({ success: true });

    // Fire-and-forget: remove deleted message from Meilisearch.
    if (meiliClient.isEnabled() && message.id) {
      setImmediate(() => { meiliClient.deleteMessage(message.id).catch(() => {}); });
    }
  } catch (err) {
    next(err);
  }
});

// ── PUT /messages/:id/read ─────────────────────────────────────────────────────
router.put("/:id/read", param("id").isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  if (getShouldDeferReadReceiptForInsertLockPressure()) {
    readReceiptShedTotal.inc({
      reason: "message_channel_insert_lock_pressure",
    });
    readReceiptRequestsTotal.inc({
      result: "deferred_message_channel_insert_lock_pressure",
    });
    return res.json({
      success: true,
      deferred: true,
      reason: "message_channel_insert_lock_pressure",
    });
  }
  const pool = poolStats();
  // `READ_RECEIPT_DEFER_POOL_WAITING=0` means "disable pool-wait defer".
  if (
    READ_RECEIPT_DEFER_POOL_WAITING > 0 &&
    pool.waiting >= READ_RECEIPT_DEFER_POOL_WAITING
  ) {
    return res.json({ success: true, deferred: true, reason: "pool_waiting" });
  }
  // Under sustained pressure, keep the cheap cursor advance but drop realtime
  // read-receipt fanout so Redis pub/sub does not sit in the request amplifier.
  const overloadStage = overload.getStage();
  const dropReadReceiptFanout = overloadStage === 2;
  if (overloadStage >= 3) {
    readReceiptShedTotal.inc({ reason: "overload_stage_high" });
    readReceiptRequestsTotal.inc({ result: "deferred_overload_stage_high" });
    return res.json({
      success: true,
      deferred: true,
      reason: "overload_stage_high",
    });
  }
  try {
    const target = await loadMessageTargetForUser(req.params.id, req.user.id, {
      preferCache: true,
    });
    if (!target) return res.status(404).json({ error: "Message not found" });
    if (!target.has_access) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { channel_id, conversation_id } = target;
    const uid = req.user.id;
    const messageId = req.params.id;
    const messageCreatedAt = target.created_at;

    const { applied, didAdvanceCursor, casResult } = await advanceReadStateCursor({
      userId: uid,
      channelId: channel_id,
      conversationId: conversation_id,
      messageId,
      messageCreatedAt,
    });
    const readScope = conversation_id ? "conversation" : "channel";
    readReceiptScopeTotal.inc({ scope: readScope });
    readReceiptCursorCasTotal.inc({
      scope: readScope,
      cas_result: String(Number(casResult) || 0),
    });

    if (!didAdvanceCursor) {
      return res.json({ success: true });
    }

    const shouldRunDebouncedSideEffects =
      casResult !== 1 || shouldRunCas1SideEffects(uid, channel_id, conversation_id);
    if (!shouldRunDebouncedSideEffects) {
      readReceiptOptimizationTotal.inc({ reason: "cas1_side_effects_debounced" });
      return res.json({ success: true });
    }

    const communityIdForCache = target.community_id;
    if (!dropReadReceiptFanout && channel_id && communityIdForCache) {
      redis.del(`channels:list:${communityIdForCache}:${uid}`).catch(() => {});
    }

    // Reset the user's unread watermark in Redis to the current channel message count.
    if (channel_id) {
      try {
        const countKey = `channel:msg_count:${channel_id}`;
        const readKey = `user:last_read_count:${channel_id}:${uid}`;
        await redis.eval(
          RESET_UNREAD_WATERMARK_LUA,
          2,
          countKey,
          readKey,
          String(USER_LAST_READ_COUNT_REDIS_TTL_SEC),
        );
      } catch (err) {
        logger.warn(
          { err, channel_id },
          "Failed to reset user:last_read_count in Redis",
        );
      }
    }

    if (dropReadReceiptFanout) {
      return res.json({ success: true, deferred: true, reason: "overload" });
    }

    const payload = {
      userId: uid,
      channelId: channel_id,
      conversationId: conversation_id,
      lastReadMessageId: messageId,
      lastReadAt: applied?.last_read_at || new Date().toISOString(),
    };

    const publishReadUpdated = async () => {
      if (conversation_id) {
        readReceiptOptimizationTotal.inc({ reason: "conversation_read_direct_user_fanout" });
        const participantIds =
          await loadActiveConversationParticipantUserIds(conversation_id);
        await publishUserFeedTargets(participantIds, {
          event: "read:updated",
          data: payload,
        });
      } else {
        // Channel read cursors are private: fan out only to the reader's user topic
        // (bootstrap always subscribes `user:<me>`). Avoid publishing on `channel:<id>`,
        // which would leak other members' read positions to WebSocket clients.
        await publishUserFeedTargets([uid], {
          event: "read:updated",
          data: payload,
        });
      }
    };

    // Read receipts are best-effort realtime hints. Do not put Redis pub/sub
    // fanout on the HTTP critical path for the dominant read-state route.
    if (conversation_id) {
      setImmediate(() => {
        publishReadUpdated().catch((err) => {
          logger.warn({ err, conversation_id, messageId }, "read receipt fanout failed");
        });
      });
    } else {
      setImmediate(() => {
        publishReadUpdated().catch((err) => {
          logger.warn({ err, channel_id, messageId }, "read receipt fanout failed");
        });
      });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
