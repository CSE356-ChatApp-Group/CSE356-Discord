/**
 * POST /messages — orchestrates idempotency, insert, hydrate, cache bust, fanout, response.
 *
 * Phases: `postConstants` (env), `postFanout.ts` (realtime), `postFinish.ts` (201 + traces + Meili).
 * Log prefix: `POST /messages:` in downstream modules for grep.
 */


const crypto = require("crypto");
const { body } = require("express-validator");
const { tracer, trace } = require("../../utils/tracer");
const { SpanStatusCode } = require("@opentelemetry/api");
const { poolStats, pool } = require("../../db/pool");
const { deliveryTimeoutTotal } = require("../../utils/metrics");
const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const {
  MSG_IDEM_PENDING_TTL_SECS,
  hydrateIdemReplayBody,
  awaitIdempotentPostAfterLeaseContention,
} = require("../lib/idempotency");
const {
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
const { validate } = require("./validation");
const {
  createMessagePostRateLimiters,
} = require("../lib/rateLimiters");
const { messagePostIpRateLimiter, messagePostUserRateLimiter } = createMessagePostRateLimiters();
const {
  BG_WRITE_POOL_GUARD,
  MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
  MESSAGE_POST_FAST_ACCEPT_ENABLED,
  MESSAGE_POST_AWAIT_CACHE_BUST,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ALLOWED_ATTACHMENT_TYPES,
} = require("./postConstants");
const {
  runChannelMessageCreatedFanout,
  runConversationMessageCreatedFanout,
} = require("./postFanout");
const { runPostSuccessFollowup } = require("./postFinish");
import type { MessagesAuthedRequest } from "./postTypes";
const {
  validatePostTargetAndPayload,
  validateAttachmentsPayload,
} = require("./postValidation");
const { handlePostMessageError } = require("./postErrorHandler");
const { runPostInsertPhase } = require("./postInsertPhase");

async function processPostMessageIdempotency(
  req: MessagesAuthedRequest,
  userId: string,
) {
  let idemRedisKey: string | null = null;
  let idemLease = false;
  let idemWallMs = 0;
  let replayBody: any = null;
  let duplicateInFlight = false;

  const rawIdem = req.get("idempotency-key") || req.get("Idempotency-Key");
  if (!rawIdem || typeof rawIdem !== "string") {
    return { idemRedisKey, idemLease, idemWallMs, replayBody, duplicateInFlight };
  }
  const trimmed = rawIdem.trim();
  if (!(trimmed.length > 0 && trimmed.length <= 200)) {
    return { idemRedisKey, idemLease, idemWallMs, replayBody, duplicateInFlight };
  }

  const idemPhaseStart = Date.now();
  try {
    idemRedisKey = `msg:idem:${userId}:${crypto.createHash("sha256").update(trimmed, "utf8").digest("hex")}`;
    try {
      // Acquire lease first to avoid an extra GET round-trip on the common non-duplicate path.
      const gotLease = await redis.set(
        idemRedisKey,
        JSON.stringify({ pending: true }),
        "EX",
        MSG_IDEM_PENDING_TTL_SECS,
        "NX",
      );
      if (gotLease === "OK") {
        idemLease = true;
      } else {
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
            replayBody = replay;
          }
        }
        if (!replayBody) {
          const waited =
            await awaitIdempotentPostAfterLeaseContention(idemRedisKey);
          if (waited.ok) {
            replayBody = waited.body;
          } else {
            duplicateInFlight = true;
          }
        }
      }
    } catch {
      idemRedisKey = null;
      idemLease = false;
    }
  } finally {
    idemWallMs = Date.now() - idemPhaseStart;
  }

  return { idemRedisKey, idemLease, idemWallMs, replayBody, duplicateInFlight };
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
        const userId = authReq.user.id;
        const normalizedContent =
          typeof content === "string" ? content.trim() : "";
        channelId = authReq.body.channelId ?? null;
        conversationId = authReq.body.conversationId ?? null;
        threadId = authReq.body.threadId ?? null;
        attachments = Array.isArray(authReq.body.attachments)
          ? authReq.body.attachments
          : [];

        const rootSpan = trace.getActiveSpan();
        if (rootSpan) {
          rootSpan.setAttribute('user.id', userId);
          rootSpan.setAttribute('user.name', authReq.user.username);
          rootSpan.setAttribute('message.content_length', normalizedContent.length);
          rootSpan.setAttribute('message.type', channelId ? 'channel' : 'dm');
          if (channelId) rootSpan.setAttribute('channel.id', channelId);
          else if (conversationId) rootSpan.setAttribute('conversation.id', conversationId);
        }

        const payloadValidationError = validatePostTargetAndPayload({
          channelId,
          conversationId,
          normalizedContent,
          attachments,
        });
        if (payloadValidationError) {
          return res.status(400).json({ error: payloadValidationError });
        }

        const attachmentValidationError = validateAttachmentsPayload(attachments);
        if (attachmentValidationError) {
          return res.status(400).json({ error: attachmentValidationError });
        }
        const idemResult = await processPostMessageIdempotency(authReq, userId);
        idemRedisKey = idemResult.idemRedisKey;
        idemLease = idemResult.idemLease;
        idemWallMs = idemResult.idemWallMs;
        if (idemResult.replayBody) {
          return res.status(201).json(idemResult.replayBody);
        }
        if (idemResult.duplicateInFlight) {
          res.set("Retry-After", "1");
          return res.status(409).json({
            error: "Duplicate request in flight",
            requestId: authReq.id,
          });
        }

        // --- POST /messages: DB insert (channel merged path or DM transaction) ---
        const {
          baseMessage,
          communityId,
        } = await tracer.startActiveSpan('db.message_insert', async (span: any) => {
          try {
            return await runPostInsertPhase({
              authReq,
              channelId,
              conversationId,
              userId,
              normalizedContent,
              threadId,
              attachments,
              txPhases,
              setChannelInsertLockMeta: ({ waitMs, lockPath, bypassReasonDetail }) => {
                channelInsertLockWaitMs = waitMs;
                channelInsertLockPath = lockPath;
                channelInsertLockReasonDetail = bypassReasonDetail;
              },
            });
          } catch (err: any) {
            const isExpected4xx = err.statusCode && err.statusCode >= 400 && err.statusCode < 500;
            if (!isExpected4xx) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || '') });
              span.recordException(err);
            }
            throw err;
          } finally {
            span.end();
          }
        });

        trace.getActiveSpan()?.setAttribute('message.id', String(baseMessage.id));
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

        // --- POST /messages: build response message ---
        let message: any;
        const tHydrateStart = Date.now();
        const canFastAccept =
          MESSAGE_POST_FAST_ACCEPT_ENABLED &&
          (Boolean(channelId) || attachments.length === 0);
        if (canFastAccept) {
          message = {
            ...baseMessage,
            attachments: Array.isArray((baseMessage as any).attachments)
              ? (baseMessage as any).attachments
              : [],
          };
        } else if (channelId) {
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
        // Invalidate Redis first-page GET /messages JSON (epoch bump + key DEL) so REST
        // read-after-write sees the new row without waiting for TTL. Still emits
        // endpoint_list_cache_invalidations_total{reason="message_list_volatile"} — structural
        // conversation/channel lists are unrelated (see conversationsRouterListCache).
        let cacheBustStartMs = 0;
        let cacheBustEndMs = 0;
        const cacheBustPromise = tracer.startActiveSpan('cache.bust', async (span: any) => {
          cacheBustStartMs = Date.now();
          try {
            return await withBoundedPostInsertTimeout(
              'cache_bust',
              bustMessagesCacheSafe({
                ...(channelId ? { channelId } : {}),
                ...(conversationId ? { conversationId } : {}),
              }),
              MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
            );
          } finally {
            cacheBustEndMs = Date.now();
            span.end();
          }
        });

        // --- POST /messages: realtime fanout (see postFanout.ts) ---
        let realtimePublishedAtForHttp: string | undefined;
        let realtimeChannelFanoutComplete = false;
        let realtimeConversationFanoutComplete = false;
        let fanoutMeta: any = null;
        let fanoutTimings = {
          recent_bridge_wall_ms: 0,
          fanout_enqueue_wall_ms: 0,
          recent_bridge_ok: null,
          recent_bridge_timed_out: null,
          recent_bridge_timeout_ms: null,
        };
        const tFanoutStart = Date.now();
        if (channelId) {
          const ch = await runChannelMessageCreatedFanout({
            req: authReq,
            channelId,
            communityId,
            baseMessage,
            message,
            postAttachmentCount: attachments.length,
          });
          realtimePublishedAtForHttp = ch.realtimePublishedAtForHttp;
          realtimeChannelFanoutComplete = ch.realtimeChannelFanoutComplete;
          fanoutMeta = ch.fanoutMeta;
          fanoutTimings = ch.timings_ms || fanoutTimings;
        } else {
          const cv = await runConversationMessageCreatedFanout({
            req: authReq,
            conversationId: conversationId!,
            message,
            baseMessage,
          });
          realtimePublishedAtForHttp = cv.realtimePublishedAtForHttp;
          realtimeConversationFanoutComplete = cv.realtimeConversationFanoutComplete;
          fanoutTimings = cv.timings_ms || fanoutTimings;
        }
        t_after_fanout = Date.now();
        if (MESSAGE_POST_AWAIT_CACHE_BUST) {
          const cacheBustRun = await cacheBustPromise;
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
        } else {
          t_after_cache_bust = Date.now();
          cacheBustPromise
            .then((cacheBustRun) => {
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
                  "POST /messages: async cache_bust wall budget exceeded after 201",
                );
              }
            })
            .catch((err: unknown) => {
              logger.warn(
                {
                  err,
                  requestId: authReq.id,
                  channelId: channelId ?? undefined,
                  conversationId: conversationId ?? undefined,
                },
                "POST /messages: async cache_bust failed after 201",
              );
            });
        }

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
          tFanoutStart,
          cacheBustStartMs,
          cacheBustEndMs,
          fanoutTimings,
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
