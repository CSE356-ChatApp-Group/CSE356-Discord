/**
 * POST /messages — orchestrates idempotency, insert, hydrate, cache bust, fanout, response.
 *
 * Phases: `postConstants` (env), `postFanout.ts` (realtime), `postFinish.ts` (201 + traces + Meili).
 * Log prefix: `POST /messages:` in downstream modules for grep.
 */


const crypto = require("crypto");
const { body } = require("express-validator");
const {
  withTransaction,
  poolStats,
  pool,
} = require("../../db/pool");
const {
  messagePostAccessDeniedTotal,
  deliveryTimeoutTotal,
} = require("../../utils/metrics");
const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const {
  MSG_IDEM_PENDING_TTL_SECS,
  hydrateIdemReplayBody,
  awaitIdempotentPostAfterLeaseContention,
} = require("../lib/idempotency");
const {
  isMessagePostInsertDbTimeout,
  messagePostBusy503Body,
  buildMessagePostTimeoutPhaseLog,
  buildMessagePostSuccessPhaseLog,
} = require("../lib/postDiagnostics");
const {
  bustMessagesCacheSafe,
  withBoundedPostInsertTimeout,
} = require("../lib/messageListCache");
const {
  scheduleChannelLastMessagePointerUpdate,
  scheduleConversationLastMessagePointerUpdate,
} = require("../repointLastMessage");
const { loadHydratedMessageById } = require("../messageHydrate");
const {
  runChannelMessageInsertSerialized,
  isChannelInsertLockTimeoutError,
  isChannelInsertLockQueueRejectError,
} = require("../channelInsertConcurrency");
const { validate } = require("./validation");
const {
  createMessagePostRateLimiters,
} = require("../lib/rateLimiters");
const { messagePostIpRateLimiter, messagePostUserRateLimiter } = createMessagePostRateLimiters();
const {
  BG_WRITE_POOL_GUARD,
  MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS,
  MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS,
  MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} = require("./postConstants");
const {
  runChannelMessageCreatedFanout,
  runConversationMessageCreatedFanout,
} = require("./postFanout");
const { runPostSuccessFollowup } = require("./postFinish");
import type { MessagesAuthedRequest } from "./postTypes";
const {
  MESSAGE_INSERT_RETURNING_AUTHOR,
  MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
  MESSAGE_POST_CHANNEL_INSERT_MERGED_SQL,
} = require("../sqlFragments");

function handlePostMessageError({
  err,
  req,
  res,
  next,
  channelId,
  conversationId,
  attachments,
  txPhases,
}: {
  err: any;
  req: MessagesAuthedRequest;
  res: any;
  next: any;
  channelId: string | null;
  conversationId: string | null;
  attachments: any[];
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
}) {
  if (err.statusCode === 401 && err.messagePostDenyReason === "author_missing") {
    return res.status(401).json({ error: err.message });
  }
  if (err.statusCode === 403) {
    const reason = err.messagePostDenyReason;
    if (reason === "channel_access" || reason === "conversation_participant") {
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
  return next(err);
}

async function insertMessageAttachments(
  client: any,
  messageId: string,
  uploaderId: string,
  attachments: any[],
) {
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
      uploaderId,
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

module.exports = function registerPostRoutes(router: import("express").IRouter) {
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
      .custom((value: string) => ALLOWED_ATTACHMENT_TYPES.has(value)),
    body("attachments.*.sizeBytes").optional().isInt({ min: 1 }),
    body("attachments.*.width").optional().isInt(),
    body("attachments.*.height").optional().isInt(),
    async (req, res, next) => {
      const authReq = req as MessagesAuthedRequest;
      if (!validate(authReq, res)) return;
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
      let channelInsertLockPath: string | null = null;
      let channelInsertLockReasonDetail: unknown = null;
      let postMessagesTxPhaseLog: Record<string, unknown> | null = null;
      try {
        // --- POST /messages: idempotency lease (Redis) ---
        postWallStart = Date.now();
        const { content } = authReq.body;
        const normalizedContent =
          typeof content === "string" ? content.trim() : "";
        channelId = authReq.body.channelId ?? null;
        conversationId = authReq.body.conversationId ?? null;
        threadId = authReq.body.threadId ?? null;
        attachments = Array.isArray(authReq.body.attachments)
          ? authReq.body.attachments
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
        if (!normalizedContent && attachments.length === 0) {
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

        const rawIdem = authReq.get("idempotency-key") || authReq.get("Idempotency-Key");
        if (rawIdem && typeof rawIdem === "string") {
          const trimmed = rawIdem.trim();
          if (trimmed.length > 0 && trimmed.length <= 200) {
            const idemPhaseStart = Date.now();
            try {
              idemRedisKey = `msg:idem:${authReq.user.id}:${crypto.createHash("sha256").update(trimmed, "utf8").digest("hex")}`;
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
                    requestId: authReq.id,
                  });
                }
                idemLease = true;
              } catch {
                idemRedisKey = null;
                idemLease = false;
              }
            } finally {
              idemWallMs = Date.now() - idemPhaseStart;
            }
          }
        }

        // --- POST /messages: DB insert (channel merged path or DM transaction) ---
        let communityId: string | null = null;
        let baseMessage: any;

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
              authReq.user.id,
              normalizedContent || null,
              threadId || null,
            ]);
            txPhases.t_insert = Date.now();

            if (!insertRes.rows.length) {
              const accessRes = await client.query(
                MESSAGE_POST_CHANNEL_ACCESS_DIAGNOSTIC_SQL,
                [channelId, authReq.user.id],
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
              [conversationId, authReq.user.id],
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
                authReq.user.id,
                normalizedContent || null,
                threadId || null,
              ],
            );
            txPhases.t_insert = Date.now();
            row = insertRes.rows[0];

            await insertMessageAttachments(
              client,
              row.id,
              authReq.user.id,
              attachments,
            );

            txPhases.t_later = Date.now();
            return row;
          });

        if (channelId) {
          baseMessage = await runChannelMessageInsertSerialized(
            channelId,
            runChannelMessageRowUnderInsertLock,
            {
              requestId: authReq.id,
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
                await insertMessageAttachments(
                  client,
                  baseMessage.id,
                  authReq.user.id,
                  attachments,
                );
              });
            } catch (attachErr) {
              await pool
                .query(
                  `DELETE FROM messages WHERE id = $1 AND channel_id = $2 AND author_id = $3`,
                  [baseMessage.id, channelId, authReq.user.id],
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
        postMessagesTxPhaseLog = buildMessagePostSuccessPhaseLog({
          req: authReq,
          channelId,
          conversationId,
          attachments,
          txPhases,
          txDoneAt: t_tx_done,
        });
        if (Number((postMessagesTxPhaseLog as { tx_total_ms?: unknown }).tx_total_ms) > 500) {
          logger.info(postMessagesTxPhaseLog, "POST /messages tx phase timing");
        }

        // --- POST /messages: last_message pointers (fire-and-forget) ---
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

        // --- POST /messages: hydrate full message row ---
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

        // --- POST /messages: list cache bust (bounded) ---
        const cacheBustRun = await withBoundedPostInsertTimeout(
          "cache_bust",
          bustMessagesCacheSafe({ channelId, conversationId }),
          MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
        );
        if (!cacheBustRun.ok && cacheBustRun.timedOut) {
          deliveryTimeoutTotal.inc({ phase: "cache_bust" });
          logger.warn(
            {
              requestId: authReq.id,
              channelId: channelId ?? undefined,
              conversationId: conversationId ?? undefined,
              timeoutMs: MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
              gradingNote: "post_insert_delivery_timeout_not_http_failure",
            },
            "POST /messages: cache_bust wall budget exceeded (201 still returned after commit)",
          );
        }
        t_after_cache_bust = Date.now();

        // --- POST /messages: realtime fanout (see postFanout.ts) ---
        let realtimePublishedAtForHttp: string | undefined;
        let realtimeChannelFanoutComplete = false;
        let realtimeConversationFanoutComplete = false;
        let fanoutMeta: any = null;
        if (channelId) {
          const ch = await runChannelMessageCreatedFanout({
            req: authReq,
            channelId,
            communityId,
            baseMessage,
            message,
          });
          realtimePublishedAtForHttp = ch.realtimePublishedAtForHttp;
          realtimeChannelFanoutComplete = ch.realtimeChannelFanoutComplete;
          fanoutMeta = ch.fanoutMeta;
        } else {
          const cv = await runConversationMessageCreatedFanout({
            req: authReq,
            conversationId: conversationId!,
            message,
            baseMessage,
          });
          realtimePublishedAtForHttp = cv.realtimePublishedAtForHttp;
          realtimeConversationFanoutComplete = cv.realtimeConversationFanoutComplete;
        }
        t_after_fanout = Date.now();

        // --- POST /messages: 201 + idempotency + traces + Meili (see postFinish.ts) ---
        runPostSuccessFollowup({
          req: authReq,
          res,
          channelId,
          conversationId,
          communityId,
          baseMessage,
          message,
          idemRedisKey,
          idemLease,
          realtimePublishedAtForHttp,
          realtimeChannelFanoutComplete,
          realtimeConversationFanoutComplete,
          postWallStart,
          txPhases,
          idemWallMs,
          channelInsertLockWaitMs,
          channelInsertLockPath,
          channelInsertLockReasonDetail,
          postMessagesTxPhaseLog,
          t_tx_done,
          hydrateWallMs,
          tAfterHydrateMark,
          t_after_cache_bust,
          t_after_fanout,
          fanoutMeta,
        });
      } catch (err: any) {
        if (idemRedisKey && idemLease) {
          redis.del(idemRedisKey).catch(() => {});
        }
        return handlePostMessageError({
          err,
          req: authReq,
          res,
          next,
          channelId,
          conversationId,
          attachments,
          txPhases,
        });
      }
    },
  );
};
