/**
 * PUT /messages/:id/read
 *
 * Log prefix: `PUT /messages:` for grep.
 */


const { param } = require("express-validator");
const { validate } = require("./validation");
const { poolStats } = require("../../db/pool");
const {
  readReceiptShedTotal,
  readReceiptRequestsTotal,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
  readReceiptDbUpsertTotal,
} = require("../../utils/metrics");
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require("../messageInsertLockPressure");
const overload = require("../../utils/overload");
const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const sideEffects = require("../sideEffects");
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
} = require("../lib/readReceiptState");
const { publishConversationEventNow } = require("../lib/conversationFanout");
const { publishUserFeedTargets } = require("../../websocket/userFeed");
const { loadMessageTargetForUser } = require("../accessCaches");

const USER_LAST_READ_COUNT_REDIS_TTL_SEC = parseInt(
  process.env.USER_LAST_READ_COUNT_REDIS_TTL_SEC || "604800",
  10,
);

module.exports = function registerReadRoutes(router) {
  // --- PUT /messages/:id/read: read receipt ---
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
};

