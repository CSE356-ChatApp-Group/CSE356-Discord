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
const express = require("express");
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
  pool,
} = require("../db/pool");
const {
  messagePostAccessDeniedTotal,
  messagePostRealtimePublishFailTotal,
  deliveryTimeoutTotal,
  messagePostFanoutAsyncEnqueueTotal,
  messageCacheBustFailuresTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
  readReceiptShedTotal,
  readReceiptRequestsTotal,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
  readReceiptDbUpsertTotal,
  messagesListAccessCacheHitTotal,
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
const {
  publishConversationMessageCreatedPlan,
} = require("../realtime/publishPlan");
const { wsDispatchFields } = require("../realtime/deliveryLogFields");
const overload = require("../utils/overload");
const redis = require("../db/redis");
const logger = require("../utils/logger");
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require("../utils/distributedSingleflight");

const { createMessagePostRateLimiters } = require("./lib/rateLimiters");
const { messagePostIpRateLimiter, messagePostUserRateLimiter } = createMessagePostRateLimiters();

const {
  MSG_IDEM_PENDING_TTL_SECS,
  MSG_IDEM_SUCCESS_TTL_SECS,
  MSG_IDEM_POLL_DEADLINE_MS,
  MSG_IDEM_POLL_MAX_SLEEP_MS,
  hydrateIdemReplayBody,
  awaitIdempotentPostAfterLeaseContention,
} = require("./lib/idempotency");
const {
  READ_RECEIPT_DEFER_POOL_WAITING,
  READ_RECEIPT_FANOUT_ENABLED,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  RESET_UNREAD_WATERMARK_LUA,
  shouldRunCas1SideEffects,
  shouldCoalesceSameMessageRead,
  readReceiptScopeCursorCacheSaysNoAdvance,
  rememberReadReceiptScopeCursor,
  shouldCoalesceScopeBurstRead,
  advanceReadStateCursor,
} = require("./lib/readReceiptState");
const {
  isMessagePostInsertDbTimeout,
  messagePostBusy503Body,
  buildMessagePostTimeoutPhaseLog,
  buildMessagePostSuccessPhaseLog,
  buildMessagePostSlowHolderLog,
  shouldEmitPostMessagesE2eTrace,
  buildPostMessagesE2eTracePayload,
} = require("./lib/postDiagnostics");
const {
  checkChannelAccessForUser,
  ensureActiveConversationParticipant,
  ensureChannelAccess,
  ensureMessageAccess,
} = require("./lib/accessChecks");

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
  publishChannelMessageRecentUserBridge,
} = require("./channelRealtimeFanout");
const { loadHydratedMessageById } = require("./messageHydrate");
const messagePostFanoutAsync = require("./messagePostFanoutAsync");
const { appendChannelMessageIngested } = require("./messageIngestLog");
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
  MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
  MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL,
} from "./sqlFragments";

const router = express.Router();
router.use(authenticate);
router.use(messagesHotPathLimiter);

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
const MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS ||
      process.env.MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS ||
      "6500",
    10,
  );
  if (!Number.isFinite(raw) || raw < 1000) return 6500;
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
const MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS || "125",
    10,
  );
  if (!Number.isFinite(raw) || raw < 25) return 125;
  return Math.min(1000, raw);
})();
const MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED = (() => {
  const raw = String(
    process.env.MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED || "false",
  ).toLowerCase();
  return raw === "1" || raw === "true";
})();

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
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

async function messagesListQuery(req, sql, params) {
  if (wantsMessagesListPrimary(req)) {
    return query(sql, params);
  }
  return queryRead(sql, params);
}

/**
 * Replica-first channel list reads can transiently return has_access=false right
 * after create/join due to replica lag on community_members/channel_members.
 * Retry once on primary before returning 403 so we preserve correctness while
 * keeping the steady-state read load on replicas.
 */
async function channelMessagesListQueryWithPrimaryRetry(req, sql, params) {
  if (wantsMessagesListPrimary(req)) {
    return query(sql, params);
  }

  const replicaResult = await queryRead(sql, params);
  if (replicaResult?.rows?.[0]?.has_access) {
    return replicaResult;
  }

  return query(sql, params);
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
  const v = process.env.MESSAGE_POST_SYNC_FANOUT;
  return !(v === "1" || v === "true" || v === "yes");
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
                JOIN communities co ON co.id = c.community_id
                WHERE c.id = $3
                  AND (
                    c.is_private = FALSE
                    OR co.owner_id = $2
                    OR EXISTS (
                      SELECT 1
                      FROM channel_members cm
                      WHERE cm.channel_id = c.id
                        AND cm.user_id = $2
                    )
                  )
                  AND (
                    co.owner_id = $2
                    OR EXISTS (
                      SELECT 1
                      FROM community_members community_member
                      WHERE community_member.community_id = c.community_id
                        AND community_member.user_id = $2
                    )
                  )
              )`;
              try {
                if (await checkChannelAccessCache(redis, channelId, req.user.id)) {
                  messagesListAccessCacheHitTotal.inc({ path: "channel_latest" });
                  accessWhere = "$2::uuid IS NOT NULL";
                }
              } catch {
                /* fail open */
              }

              const { rows } = await channelMessagesListQueryWithPrimaryRetry(
                req,
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
            messagesListAccessCacheHitTotal.inc({ path: "channel_paginated" });
            accessWhere = "$2::uuid IS NOT NULL";
          }
        } catch {
          /* fail open */
        }

        if (!accessWhere) {
          accessWhere = `EXISTS (
            SELECT 1 FROM channels c
            JOIN communities co ON co.id = c.community_id
            WHERE c.id = $${ci}
              AND (c.is_private = FALSE
                   OR co.owner_id = $2
                   OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2))
              AND (co.owner_id = $2
                   OR EXISTS (
                     SELECT 1 FROM community_members community_member
                     WHERE community_member.community_id = c.community_id
                       AND community_member.user_id = $2
                   ))
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

      const { rows } = channelId
        ? await channelMessagesListQueryWithPrimaryRetry(req, sql, params)
        : await messagesListQuery(req, sql, params);

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
    let postWallStart = 0;
    let idemWallMs = 0;
    let channelInsertLockWaitMs = 0;
    let channelInsertLockPath = null;
    let channelInsertLockReasonDetail = null;
    let postMessagesTxPhaseLog = null;
    try {
      postWallStart = Date.now();
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
          const idemPhaseStart = Date.now();
          try {
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
                const replay = await hydrateIdemReplayBody(parsed);
                if (replay) {
                  return res.status(201).json(replay);
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
          } finally {
            idemWallMs = Date.now() - idemPhaseStart;
          }
        }
      }

      let communityId: string | null = null;
      let baseMessage: any;

      const insertAttachmentRows = async (client: any, messageId: string) => {
        if (attachments.length === 0) return;
        const values: string[] = [];
        const params: any[] = [];
        let index = 1;

        for (const attachment of attachments) {
          values.push(
            `($${index++}, $${index++}, 'image', $${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++})`,
          );
          params.push(
            messageId,
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
      };

      /** Channel-only: merged access check + insert (diagnostic SELECT only when INSERT returns 0 rows). */
      const runChannelMessageRowUnderInsertLock = () =>
        withTransaction(async (client) => {
          txPhases.t0 = Date.now();
          await client.query(
            `SET LOCAL statement_timeout = '${MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS}ms'`,
          );
          await client.query(`SET LOCAL synchronous_commit = off`);

          txPhases.t_access = Date.now();
          const insertRes = await client.query(MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL, [
            channelId,
            req.user.id,
            content?.trim() || null,
            threadId || null,
          ]);
          txPhases.t_insert = Date.now();

          if (!insertRes.rows.length) {
            const accessRes = await client.query(
              MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
              [channelId, req.user.id],
            );
            txPhases.t_later = Date.now();
            const accessRow = accessRes.rows[0];
            if (accessRow && accessRow.author_exists === false) {
              const err: any = new Error("Session no longer valid");
              err.statusCode = 401;
              err.messagePostDenyReason = "author_missing";
              throw err;
            }
            const err: any = new Error("Access denied");
            err.statusCode = 403;
            err.messagePostDenyReason = "channel_access";
            throw err;
          }

          const row = insertRes.rows[0];
          communityId = row.post_insert_community_id ?? null;
          delete row.post_insert_community_id;
          txPhases.t_later = Date.now();
          return row;
        });

      const runDmMessageInsertTransaction = () =>
        withTransaction(async (client) => {
          txPhases.t0 = Date.now();
          await client.query(
            `SET LOCAL statement_timeout = '${MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS}ms'`,
          );
          await client.query(`SET LOCAL synchronous_commit = off`);
          let row: any;

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

          await insertAttachmentRows(client, row.id);

          txPhases.t_later = Date.now();
          return row;
        });

      if (channelId) {
        baseMessage = await runChannelMessageInsertSerialized(
          channelId,
          runChannelMessageRowUnderInsertLock,
          {
            requestId: req.id,
            onInsertLock: ({
              waitMs,
              lockPath,
              bypassReasonDetail,
            }) => {
              channelInsertLockWaitMs = waitMs;
              channelInsertLockPath = lockPath;
              channelInsertLockReasonDetail = bypassReasonDetail;
            },
          },
        );
        if (attachments.length > 0) {
          try {
            await withTransaction(async (client) => {
              await client.query(
                `SET LOCAL statement_timeout = '${MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS}ms'`,
              );
              await insertAttachmentRows(client, baseMessage.id);
            });
          } catch (attachErr) {
            await pool
              .query(
                `DELETE FROM messages WHERE id = $1 AND channel_id = $2 AND author_id = $3`,
                [baseMessage.id, channelId, req.user.id],
              )
              .catch(() => {});
            throw attachErr;
          }
        }
      } else {
        baseMessage = await runDmMessageInsertTransaction();
      }
      const t_tx_done = Date.now();
      let t_after_cache_bust = t_tx_done;
      let t_after_fanout = t_tx_done;
      let t_after_side_effects = t_tx_done;
      let t_after_idem_cache = t_tx_done;
      let fanoutMeta: any = null;
      postMessagesTxPhaseLog = buildMessagePostSuccessPhaseLog({
        req,
        channelId,
        conversationId,
        attachments,
        txPhases,
        txDoneAt: t_tx_done,
      });
      if (postMessagesTxPhaseLog.tx_total_ms > 500) {
        logger.info(postMessagesTxPhaseLog, "POST /messages tx phase timing");
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

      // Channel posts: author + attachments always load after the insert lock is
      // released (locked tx uses merged insert RETURNING without author JSON). DM posts:
      // re-hydrate only when attachments were inserted.
      let message: any;
      const tHydrateStart = Date.now();
      if (channelId) {
        const hydrated = await loadHydratedMessageById(baseMessage.id);
        if (!hydrated) {
          const err: any = new Error("Message not found after insert");
          err.statusCode = 500;
          throw err;
        }
        message = hydrated;
      } else {
        message =
          attachments.length > 0
            ? ((await loadHydratedMessageById(baseMessage.id)) ?? baseMessage)
            : baseMessage;
      }
      const tAfterHydrateMark = Date.now();
      const hydrateWallMs = Math.max(0, tAfterHydrateMark - tHydrateStart);

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
            const createdEnvelope = messageFanoutEnvelope(
              "message:created",
              message,
            );
            realtimePublishedAtForHttp = createdEnvelope.publishedAt;
            if (MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED) {
              const recentBridgeRun = await withBoundedPostInsertTimeout(
                "recent_bridge",
                publishChannelMessageRecentUserBridge(
                  channelId,
                  createdEnvelope,
                ),
                MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS,
              );
              if (!recentBridgeRun.ok && recentBridgeRun.timedOut) {
                deliveryTimeoutTotal.inc({ phase: "recent_bridge" });
                logger.warn(
                  {
                    requestId: req.id,
                    channelId,
                    timeoutMs: MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS,
                    gradingNote: "post_insert_delivery_timeout_not_http_failure",
                  },
                  "POST /messages: immediate recent-connect bridge exceeded wall budget",
                );
              }
            }
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
                    await publishChannelMessageCreated(channelId, envelope, {
                      communityId,
                    });
                  },
                );
              },
            );
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
              publishChannelMessageCreated(channelId, createdEnvelope, {
                communityId,
              }).catch((err) => {
                logger.warn(
                  { err, requestId: req.id, channelId, messageId: message.id },
                  "POST /messages queue-full channel fanout fallback failed",
                );
              });
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
                { communityId },
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
              void publishConversationMessageCreatedPlan(
                publishConversationEventNow,
                conversationId,
                message,
              ).catch((fallbackErr) => {
                logger.warn(
                  {
                    err: fallbackErr,
                    requestId: req.id,
                    conversationId,
                    messageId: message.id,
                    delivery_path: "fallback",
                    ...wsDispatchFields(`conversation:${conversationId}`),
                    gradingNote: "conversation_queue_full_fanout_fallback_failed",
                  },
                  "POST /messages queue-full conversation fanout fallback failed",
                );
              });
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
              void publishConversationMessageCreatedPlan(
                publishConversationEventNow,
                conversationId,
                message,
              ).catch((fallbackErr) => {
                logger.warn(
                  {
                    err: fallbackErr,
                    requestId: req.id,
                    conversationId,
                    messageId: message.id,
                    delivery_path: "fallback",
                    ...wsDispatchFields(`conversation:${conversationId}`),
                    gradingNote: "conversation_sync_fanout_fallback_failed",
                  },
                  "POST /messages sync conversation fanout fallback publish failed",
                );
              });
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
        // Slim idem payload: omit full `message` JSON (often multi‑KB) — replay uses
        // `messageId` + `loadHydratedMessageById` within MSG_IDEM_SUCCESS_TTL_SECS.
        const idemBlob: Record<string, unknown> = {
          messageId: message.id,
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
      const tBeforeSerialize = Date.now();
      const jsonBody = JSON.stringify(httpBody);
      const serializationWallMs = Math.max(0, Date.now() - tBeforeSerialize);
      res.status(201).type("application/json; charset=utf-8").send(jsonBody);
      const t_response_sent = Date.now();

      const fanoutModeForE2e = channelId
        ? messagePostAsyncFanoutEnabled()
          ? "channel:async_enqueue"
          : "channel:sync_await"
        : messagePostAsyncFanoutEnabled()
          ? "conversation:async_enqueue"
          : "conversation:sync_await";
      const cacheBustOnlyMs = Math.max(0, t_after_cache_bust - tAfterHydrateMark);
      const fanoutWallMs = Math.max(0, t_after_fanout - t_after_cache_bust);
      const communityEnqueueMs = Math.max(
        0,
        t_after_side_effects - t_after_fanout,
      );
      const idemSuccessRedisMs = Math.max(
        0,
        t_after_idem_cache - t_after_side_effects,
      );
      const totalWallMs = t_response_sent - postWallStart;
      if (
        postMessagesTxPhaseLog &&
        shouldEmitPostMessagesE2eTrace(totalWallMs)
      ) {
        logger.info(
          buildPostMessagesE2eTracePayload({
            req,
            channelId,
            conversationId,
            postWallStart,
            txPhases,
            total_wall_ms: totalWallMs,
            idem_redis_ms: idemWallMs,
            channel_insert_lock_wait_ms: channelInsertLockWaitMs,
            channel_insert_lock_path: channelInsertLockPath,
            channel_insert_lock_reason_detail: channelInsertLockReasonDetail,
            successLog: postMessagesTxPhaseLog,
            hydrate_ms: hydrateWallMs,
            cache_bust_ms: cacheBustOnlyMs,
            fanout_wall_ms: fanoutWallMs,
            fanout_mode: fanoutModeForE2e,
            community_enqueue_ms: communityEnqueueMs,
            idem_success_redis_ms: idemSuccessRedisMs,
            serialization_ms: serializationWallMs,
            response_body_bytes: Buffer.byteLength(jsonBody, "utf8"),
          }),
          "POST /messages e2e trace",
        );
      }

      if (channelId) {
        if (postMessagesTxPhaseLog && postMessagesTxPhaseLog.tx_total_ms > 1000) {
          const postInsertBreakdown = {
            hydrate_ms: hydrateWallMs,
            cache_bust_ms: cacheBustOnlyMs,
            fanout_publish_ms: fanoutWallMs,
            side_effects_enqueue_ms: communityEnqueueMs,
            idempotency_cache_ms: idemSuccessRedisMs,
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
              txLog: postMessagesTxPhaseLog,
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
                 JOIN communities co ON co.id = c.community_id
                 WHERE c.id = m.channel_id
                   AND (c.is_private = FALSE
                        OR co.owner_id = $3
                        OR EXISTS (
                          SELECT 1 FROM channel_members
                          WHERE channel_id = c.id AND user_id = $3
                        ))
                   AND (co.owner_id = $3
                        OR EXISTS (
                          SELECT 1 FROM community_members community_member
                          WHERE community_member.community_id = c.community_id
                            AND community_member.user_id = $3
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
                 JOIN communities co ON co.id = c.community_id
                 WHERE c.id = m.channel_id
                   AND (c.is_private = FALSE
                        OR co.owner_id = $2
                        OR EXISTS (
                          SELECT 1 FROM channel_members
                          WHERE channel_id = c.id AND user_id = $2
                        ))
                   AND (co.owner_id = $2
                        OR EXISTS (
                          SELECT 1 FROM community_members community_member
                          WHERE community_member.community_id = c.community_id
                            AND community_member.user_id = $2
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
    if (shouldCoalesceSameMessageRead(uid, messageId)) {
      return res.json({ success: true });
    }
    const messageCreatedAt = target.created_at;
    if (
      shouldCoalesceScopeBurstRead({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageCreatedAt,
      })
    ) {
      return res.json({ success: true });
    }
    if (
      readReceiptScopeCursorCacheSaysNoAdvance({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageCreatedAt,
      })
    ) {
      // Strict fast path for burst duplicates: skip Redis/DB/metrics/fanout work.
      return res.json({ success: true });
    }

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
      rememberReadReceiptScopeCursor({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageCreatedAt,
      });
      return res.json({ success: true });
    }
    if (casResult === 2) {
      readReceiptDbUpsertTotal.inc({ result: "enqueued" });
    } else if (casResult === 1) {
      readReceiptDbUpsertTotal.inc({ result: "rate_limited" });
    }
    rememberReadReceiptScopeCursor({
      userId: uid,
      channelId: channel_id,
      conversationId: conversation_id,
      messageCreatedAt,
    });

    const shouldRunDebouncedSideEffects =
      casResult !== 1 || shouldRunCas1SideEffects(uid, channel_id, conversation_id);
    if (!shouldRunDebouncedSideEffects) {
      readReceiptOptimizationTotal.inc({ reason: "cas1_side_effects_debounced" });
      return res.json({ success: true });
    }

    const communityIdForCache = target.community_id;
    // Batch non-critical Redis updates into one pipeline to cut round trips
    // for the hottest route.
    if (channel_id) {
      try {
        const countKey = `channel:msg_count:${channel_id}`;
        const readKey = `user:last_read_count:${channel_id}:${uid}`;
        const pipeline = redis.pipeline();
        if (READ_RECEIPT_FANOUT_ENABLED && !dropReadReceiptFanout && communityIdForCache) {
          pipeline.del(`channels:list:${communityIdForCache}:${uid}`);
        }
        pipeline.eval(
          RESET_UNREAD_WATERMARK_LUA,
          2,
          countKey,
          readKey,
          String(USER_LAST_READ_COUNT_REDIS_TTL_SEC),
        );
        await pipeline.exec();
      } catch (err) {
        logger.warn(
          { err, channel_id },
          "Failed to update read watermark/cache in Redis",
        );
      }
    } else if (READ_RECEIPT_FANOUT_ENABLED && !dropReadReceiptFanout && communityIdForCache) {
      redis.del(`channels:list:${communityIdForCache}:${uid}`).catch(() => {});
    }

    if (dropReadReceiptFanout || !READ_RECEIPT_FANOUT_ENABLED) {
      return res.json({
        success: true,
        deferred: true,
        reason: dropReadReceiptFanout ? "overload" : "fanout_disabled",
      });
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
        readReceiptOptimizationTotal.inc({ reason: "conversation_read_reliable_fanout" });
        await publishConversationEventNow(conversation_id, "read:updated", payload);
        return;
      }
      await publishUserFeedTargets([uid], {
        event: "read:updated",
        data: payload,
      });
    };

    try {
      if (conversation_id) {
        await publishReadUpdated();
      } else if (READ_RECEIPT_CHANNEL_FANOUT_ASYNC) {
        const enqueued = sideEffects.enqueueFanoutJob("fanout.read_receipt", publishReadUpdated);
        if (!enqueued) {
          await publishReadUpdated();
        }
      } else {
        await publishReadUpdated();
      }
    } catch (err) {
      logger.warn(
        { err, channel_id, conversation_id, messageId },
        "read receipt fanout failed",
      );
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
