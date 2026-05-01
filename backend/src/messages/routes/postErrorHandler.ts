/**
 * HTTP error mapping for POST /messages (keeps post.ts route thin).
 */

import type { MessagesAuthedRequest } from "./postTypes";

const {
  messagePostAccessDeniedTotal,
} = require("../../utils/metrics");
const logger = require("../../utils/logger");
const {
  isMessagePostInsertDbTimeout,
  shouldMarkReadShedFromPostInsertDbTimeout,
  messagePostBusy503Body,
  buildMessagePostTimeoutPhaseLog,
} = require("../lib/postDiagnostics");
const {
  markMessageInsertUnhealthyForReadShedding,
} = require("../messageInsertHealth");
const {
  isChannelInsertLockTimeoutError,
  isChannelInsertLockQueueRejectError,
} = require("../channelInsertConcurrency");

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
    if (shouldMarkReadShedFromPostInsertDbTimeout(err, txPhases)) {
      markMessageInsertUnhealthyForReadShedding();
    }
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

module.exports = { handlePostMessageError };
