/**
 * Shared HTTP logic for PUT /messages/:id/read and PUT /messages/batch-read.
 * Lives under `readReceipt/` with Redis-backed read-state batching (`../readState/batchReadState.ts`);
 * `routes/read.ts` only registers Express handlers.
 */

const { poolStats, query } = require("../../db/pool");
const {
  readReceiptShedTotal,
  readReceiptRequestsTotal,
  readReceiptPreflightTotal,
  readReceiptPreflightPoolWaiting,
  readReceiptCursorCasTotal,
  readReceiptScopeTotal,
  readReceiptOptimizationTotal,
  readReceiptNoopSkipTotal,
  readReceiptCoalescedTotal,
  readReceiptDbUpsertTotal,
  readReceiptPhaseDurationMs,
} = require("../../utils/metrics");
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require("../messageInsertLockPressure");
const {
  getShouldDeferReadReceiptForMessageInsertUnhealthy,
} = require("../messageInsertHealth");
const overload = require("../../utils/overload");
const redis = require("../../db/redis");
const { ensureRedisLuaSha, REDIS_LUA_IDS } = require("../../db/redisLua");
const { countKeyForChannel, userLastReadCountKey } = require("../channelMessageCounter");
const logger = require("../../utils/logger");
const sideEffects = require("../sideEffects");
const {
  READ_RECEIPT_DEFER_POOL_WAITING,
  READ_RECEIPT_FANOUT_ENABLED,
  READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  hasConfirmedRecentMessageRead,
  rememberConfirmedMessageRead,
  shouldRunCas1SideEffects,
  shouldCoalesceSameMessageRead,
  readReceiptScopeCursorCacheSaysNoAdvance,
  readReceiptScopeCursorHintSaysNoAdvance,
  rememberReadReceiptScopeCursor,
  rememberReadReceiptScopeCursorMergedWithRedis,
  shouldCoalesceScopeBurstRead,
  advanceReadStateCursor,
} = require("../lib/readReceiptState");
const { publishConversationEventNow } = require("../fanout/conversationFanout");
const { publishUserFeedTargets } = require("../../websocket/userFeed");
const { loadMessageTargetForUser } = require("../accessCaches");
const {
  tryHitReadReceiptMessageAckCache,
  recordReadReceiptMessageAckAfterSuccess,
} = require("./readReceiptMessageAckCache");
const { READ_RECEIPT_TARGET_LOOKUP_CALLER } = require("./readReceiptTargetLookupDiag");
const {
  shouldDropReadReceiptFanoutForWsPressure,
  shouldFullyDeferReadReceiptForWsPressure,
} = require("../../websocket/wsDeliveryPressure");

const USER_LAST_READ_COUNT_REDIS_TTL_SEC = parseInt(
  process.env.USER_LAST_READ_COUNT_REDIS_TTL_SEC || "604800",
  10,
);

const READ_RECEIPT_BATCH_MAX = (() => {
  const raw = parseInt(process.env.READ_RECEIPT_BATCH_MAX || "50", 10);
  if (!Number.isFinite(raw)) return 50;
  return Math.min(100, Math.max(1, Math.floor(raw)));
})();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidString(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

function normalizeReadHint(rawHint: unknown) {
  if (!rawHint || typeof rawHint !== "object") return null;
  const hint = rawHint as {
    channelId?: unknown;
    channel_id?: unknown;
    conversationId?: unknown;
    conversation_id?: unknown;
    messageCreatedAt?: unknown;
    message_created_at?: unknown;
  };
  const channelId = isUuidString(hint.channelId)
    ? String(hint.channelId)
    : isUuidString(hint.channel_id)
      ? String(hint.channel_id)
      : null;
  const conversationId = isUuidString(hint.conversationId)
    ? String(hint.conversationId)
    : isUuidString(hint.conversation_id)
      ? String(hint.conversation_id)
      : null;
  if ((channelId && conversationId) || (!channelId && !conversationId)) {
    return null;
  }
  const rawMessageCreatedAt =
    typeof hint.messageCreatedAt === "string"
      ? hint.messageCreatedAt
      : typeof hint.message_created_at === "string"
        ? hint.message_created_at
        : null;
  if (!rawMessageCreatedAt) return null;
  const messageTsMs = new Date(rawMessageCreatedAt).getTime();
  if (!Number.isFinite(messageTsMs)) return null;
  return {
    channelId,
    conversationId,
    messageCreatedAt: rawMessageCreatedAt,
    messageTsMs,
  };
}

function observeReadPreflight(result: string, poolWaiting: number) {
  readReceiptPreflightTotal.inc({ result });
  readReceiptPreflightPoolWaiting.observe(
    { result },
    Number.isFinite(poolWaiting) ? Math.max(0, poolWaiting) : 0,
  );
}

function observeReadReceiptRequest(result: string) {
  readReceiptRequestsTotal.inc({ result });
}

async function observeReadPhase(phase, fn) {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    readReceiptPhaseDurationMs.observe(
      { phase, result: "ok" },
      Math.max(0, elapsedMs),
    );
    return result;
  } catch (err) {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    readReceiptPhaseDurationMs.observe(
      { phase, result: "error" },
      Math.max(0, elapsedMs),
    );
    throw err;
  }
}

/**
 * Shared early exits (insert-lock shed, insert-timeout pressure, pool-wait defer, overload stage ≥3).
 */
function readReceiptPreflightResponse(): {
  respond: true;
  status: number;
  body: Record<string, unknown>;
  dropReadReceiptFanout?: boolean;
} | { respond: false; dropReadReceiptFanout: boolean } {
  const poolWaiting = Number(poolStats()?.waiting || 0);
  if (shouldFullyDeferReadReceiptForWsPressure()) {
    observeReadPreflight('deferred_ws_delivery_pressure', poolWaiting);
    readReceiptShedTotal.inc({ reason: "ws_delivery_pressure" });
    observeReadReceiptRequest("deferred_ws_delivery_pressure");
    return {
      respond: true,
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: "ws_delivery_pressure",
      },
    };
  }
  if (getShouldDeferReadReceiptForInsertLockPressure()) {
    observeReadPreflight('deferred_message_channel_insert_lock_pressure', poolWaiting);
    readReceiptShedTotal.inc({
      reason: "message_channel_insert_lock_pressure",
    });
    observeReadReceiptRequest("deferred_message_channel_insert_lock_pressure");
    return {
      respond: true,
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: "message_channel_insert_lock_pressure",
      },
    };
  }
  if (getShouldDeferReadReceiptForMessageInsertUnhealthy()) {
    observeReadPreflight('deferred_message_insert_unhealthy', poolWaiting);
    readReceiptShedTotal.inc({
      reason: "message_insert_unhealthy",
    });
    observeReadReceiptRequest("deferred_message_insert_unhealthy");
    return {
      respond: true,
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: "message_insert_unhealthy",
      },
    };
  }
  if (
    READ_RECEIPT_DEFER_POOL_WAITING > 0 &&
    poolWaiting >= READ_RECEIPT_DEFER_POOL_WAITING
  ) {
    observeReadPreflight('deferred_pool_waiting', poolWaiting);
    observeReadReceiptRequest("deferred_pool_waiting");
    return {
      respond: true,
      status: 200,
      body: { success: true, deferred: true, reason: "pool_waiting" },
    };
  }
  const overloadStage = overload.getStage();
  const dropReadReceiptFanout = overloadStage === 2;
  if (overloadStage >= 3) {
    observeReadPreflight('deferred_overload_stage_high', poolWaiting);
    readReceiptShedTotal.inc({ reason: "overload_stage_high" });
    observeReadReceiptRequest("deferred_overload_stage_high");
    return {
      respond: true,
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: "overload_stage_high",
      },
    };
  }
  observeReadPreflight('pass', poolWaiting);
  return { respond: false, dropReadReceiptFanout };
}

/**
 * Core per-message read receipt (after preflight). Returns HTTP status + JSON body.
 */
async function executeReadReceiptMark(
  userId: string,
  messageId: string,
  dropReadReceiptFanout: boolean,
  options: {
    hint?: unknown;
    requestId?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (hasConfirmedRecentMessageRead(userId, messageId)) {
    readReceiptNoopSkipTotal.inc({ reason: "same_message_recent_confirmed" });
    readReceiptCoalescedTotal.inc({ reason: "same_message" });
    return { status: 200, body: { success: true } };
  }

  const readHint = normalizeReadHint(options.hint);
  if (
    readHint &&
    await readReceiptScopeCursorHintSaysNoAdvance({
      userId,
      channelId: readHint.channelId,
      conversationId: readHint.conversationId,
      messageCreatedAt: readHint.messageCreatedAt,
      messageTsMs: readHint.messageTsMs,
    })
  ) {
    readReceiptNoopSkipTotal.inc({ reason: "scope_cursor_cache" });
    readReceiptCoalescedTotal.inc({ reason: "scope_cursor" });
    return { status: 200, body: { success: true } };
  }

  if (await tryHitReadReceiptMessageAckCache(userId, messageId)) {
    return { status: 200, body: { success: true } };
  }

  const needsCommunityId =
    READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE &&
    READ_RECEIPT_FANOUT_ENABLED &&
    !dropReadReceiptFanout;
  const target = await observeReadPhase("target_lookup", () =>
    loadMessageTargetForUser(messageId, userId, {
      preferCache: true,
      includeCommunityId: needsCommunityId,
      msgTargetMetricsCaller: 'read_receipt',
      targetLookupLogContext: {
        kind: READ_RECEIPT_TARGET_LOOKUP_CALLER,
        requestId: options.requestId,
      },
    }),
  );
  if (!target) {
    observeReadReceiptRequest("not_found");
    return { status: 404, body: { error: "Message not found" } };
  }
  if (!target.has_access) {
    observeReadReceiptRequest("access_denied");
    return { status: 403, body: { error: "Access denied" } };
  }

  const { channel_id, conversation_id } = target;
  const uid = userId;
  if (shouldCoalesceSameMessageRead(uid, messageId)) {
    readReceiptNoopSkipTotal.inc({ reason: "same_message_coalesced" });
    readReceiptCoalescedTotal.inc({ reason: "same_message" });
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return { status: 200, body: { success: true } };
  }
  const messageCreatedAt = target.created_at;
  const messageTsMs = new Date(messageCreatedAt).getTime();
  if (
    shouldCoalesceScopeBurstRead({
      userId: uid,
      channelId: channel_id,
      conversationId: conversation_id,
      messageCreatedAt,
      messageTsMs,
    })
  ) {
    readReceiptNoopSkipTotal.inc({ reason: "scope_burst_debounced" });
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return { status: 200, body: { success: true } };
  }
  if (
    readReceiptScopeCursorCacheSaysNoAdvance({
      userId: uid,
      channelId: channel_id,
      conversationId: conversation_id,
      messageCreatedAt,
      messageTsMs,
    })
  ) {
    readReceiptNoopSkipTotal.inc({ reason: "scope_cursor_cache" });
    readReceiptCoalescedTotal.inc({ reason: "scope_cursor" });
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return { status: 200, body: { success: true } };
  }

  const { applied, didAdvanceCursor, casResult, redisCursorMsAtCas0 } =
    await observeReadPhase("cursor_advance", () =>
      advanceReadStateCursor({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageId,
        messageCreatedAt,
        messageTsMs,
      }),
    );
  const readScope = conversation_id ? "conversation" : "channel";
  readReceiptScopeTotal.inc({ scope: readScope });
  readReceiptCursorCasTotal.inc({
    scope: readScope,
    cas_result: String(Number(casResult) || 0),
  });

  if (!didAdvanceCursor) {
    readReceiptNoopSkipTotal.inc({ reason: "cursor_not_advanced" });
    rememberConfirmedMessageRead(uid, messageId);
    if (casResult === 0) {
      await rememberReadReceiptScopeCursorMergedWithRedis({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageCreatedAt,
        messageTsMs,
        redisCursorMsAtCas0,
      });
    } else {
      rememberReadReceiptScopeCursor({
        userId: uid,
        channelId: channel_id,
        conversationId: conversation_id,
        messageCreatedAt,
        messageTsMs,
      });
    }
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return { status: 200, body: { success: true } };
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
    messageTsMs,
  });

  const shouldRunDebouncedSideEffects =
    casResult !== 1 || shouldRunCas1SideEffects(uid, channel_id, conversation_id);
  if (!shouldRunDebouncedSideEffects) {
    rememberConfirmedMessageRead(uid, messageId);
    readReceiptOptimizationTotal.inc({ reason: "cas1_side_effects_debounced" });
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return { status: 200, body: { success: true } };
  }

  const communityIdForCache = target.community_id;
  if (channel_id) {
    await observeReadPhase("watermark_cache", async () => {
      try {
        const countKey = countKeyForChannel(channel_id);
        const readKey = userLastReadCountKey(channel_id, uid);
        const wmSha = await ensureRedisLuaSha(
          redis,
          REDIS_LUA_IDS.READ_RECEIPT_RESET_UNREAD_WATERMARK,
        );
        const pipeline = redis.pipeline();
        if (
          READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE &&
          READ_RECEIPT_FANOUT_ENABLED &&
          !dropReadReceiptFanout &&
          communityIdForCache
        ) {
          pipeline.del(`channels:list:${communityIdForCache}:${uid}`);
        }
        pipeline.evalsha(
          wmSha,
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
    });
  } else if (
    READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE &&
    READ_RECEIPT_FANOUT_ENABLED &&
    !dropReadReceiptFanout &&
    communityIdForCache
  ) {
    await observeReadPhase("watermark_cache", async () => {
      await redis.del(`channels:list:${communityIdForCache}:${uid}`).catch(() => {});
    });
  }

  const dropReadReceiptFanoutForWsPressure =
    !dropReadReceiptFanout &&
    READ_RECEIPT_FANOUT_ENABLED &&
    shouldDropReadReceiptFanoutForWsPressure();

  if (dropReadReceiptFanoutForWsPressure) {
    readReceiptOptimizationTotal.inc({ reason: "ws_delivery_pressure_fanout_skipped" });
    observeReadReceiptRequest("deferred_ws_delivery_pressure_fanout_only");
    rememberConfirmedMessageRead(uid, messageId);
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return {
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: "ws_delivery_pressure",
      },
    };
  }

  if (dropReadReceiptFanout || !READ_RECEIPT_FANOUT_ENABLED) {
    observeReadReceiptRequest(
      dropReadReceiptFanout
        ? "deferred_overload_fanout_only"
        : "deferred_fanout_disabled",
    );
    await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
    return {
      status: 200,
      body: {
        success: true,
        deferred: true,
        reason: dropReadReceiptFanout ? "overload" : "fanout_disabled",
      },
    };
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

  await observeReadPhase("fanout_publish", async () => {
    try {
      if (conversation_id) {
        await publishReadUpdated();
      } else if (READ_RECEIPT_CHANNEL_FANOUT_ASYNC) {
        const enqueued = sideEffects.enqueueFanoutJob("fanout.read_receipt", publishReadUpdated);
        if (!enqueued) {
          readReceiptOptimizationTotal.inc({ reason: "channel_read_fanout_inline_fallback" });
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
  });

  rememberConfirmedMessageRead(uid, messageId);
  observeReadReceiptRequest("success");
  await recordReadReceiptMessageAckAfterSuccess(uid, messageId);
  return { status: 200, body: { success: true } };
}

/**
 * Newest-first for batch semantics (matches single-request cursor/debounce evolution).
 */
async function sortMessageIdsByCreatedAtDesc(messageIds: string[]): Promise<string[]> {
  if (messageIds.length <= 1) return messageIds;
  const { rows } = await query(
    `SELECT id::text AS id, extract(epoch from created_at) * 1000 AS ts_ms
     FROM messages WHERE id = ANY($1::uuid[])`,
    [messageIds],
  );
  const tsById = new Map(
    rows.map((r: { id: string; ts_ms: string | number }) => [
      String(r.id),
      Number(r.ts_ms) || 0,
    ]),
  );
  return [...messageIds].sort(
    (a, b) => Number(tsById.get(b) || 0) - Number(tsById.get(a) || 0),
  );
}

function normalizeBatchReads(
  rawReads: unknown,
): { messageIds: string[]; reads: Array<{ messageId: string; hint: unknown }> } | { error: string } {
  if (!Array.isArray(rawReads)) {
    return { error: "reads must be a non-empty array" };
  }
  const out: string[] = [];
  const reads: Array<{ messageId: string; hint: unknown }> = [];
  const seen = new Set<string>();
  for (const entry of rawReads) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as { messageId?: string; message_id?: string }).messageId ||
            (entry as { messageId?: string; message_id?: string }).message_id
          : null;
    if (!isUuidString(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    reads.push({
      messageId: id,
      hint: entry && typeof entry === "object" ? entry : null,
    });
  }
  if (!out.length) {
    return { error: "reads must contain at least one valid UUID messageId" };
  }
  if (out.length > READ_RECEIPT_BATCH_MAX) {
    return { error: `reads exceeds max of ${READ_RECEIPT_BATCH_MAX}` };
  }
  return { messageIds: out, reads };
}

/** Mutates `results` into the same order as `messageIds` (client request order). O(n log n) sort, O(n) map build. */
function orderBatchReadResultsByClientIndex(
  results: Array<{ messageId: string }>,
  messageIds: string[],
): void {
  const order = new Map<string, number>();
  for (let i = 0; i < messageIds.length; i++) {
    order.set(messageIds[i], i);
  }
  results.sort(
    (a, b) => (order.get(a.messageId) ?? 0) - (order.get(b.messageId) ?? 0),
  );
}

module.exports = {
  READ_RECEIPT_BATCH_MAX,
  readReceiptPreflightResponse,
  executeReadReceiptMark,
  sortMessageIdsByCreatedAtDesc,
  normalizeBatchReads,
  orderBatchReadResultsByClientIndex,
};
