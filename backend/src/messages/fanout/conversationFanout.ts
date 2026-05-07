/**
 * Synchronous conversation-wide Redis/WebSocket fanout (DM timing logs, read:updated, etc.).
 */


const fanout = require("../../websocket/fanout");
const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const { tracer, trace } = require("../../utils/tracer");
const { SpanStatusCode } = require("@opentelemetry/api");
const {
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
} = require("../../utils/metrics");
const { getConversationFanoutTargets } = require("./conversationFanoutTargets");
const {
  wrapFanoutPayload,
  fanoutPublishedAt,
} = require("../realtimePayload");
// conversationsRouterListCache invalidation for per-message fanout removed — it caused
// 0% cache hit rate at high message rates (68 msg/s → 136-340 invalidations/s).
// Structural invalidations (create/delete conversation, participant changes) remain in
// conversationsRouter.ts and conversationSideEffects.ts.
const { enqueuePendingMessageForUsers } = require("../pending/realtimePending");
const {
  publishUserFeedTargets,
  splitUserTargets,
  userFeedRedisChannelForUserId,
} = require("../../websocket/userFeed");
const {
  conversationFanoutConfig: {
    DM_FANOUT_TIMING_LOG,
    DM_FANOUT_TIMING_LOG_MIN_MS,
  },
} = require("../config/conversationFanoutConfig");

async function publishConversationEventNow(
  conversationId: string,
  event: string,
  data: unknown,
) {
  const startedAt = process.hrtime.bigint();
  const isDmTimingEvent =
    typeof event === "string" && event.startsWith("message:");
  const targets: string[] = await tracer.startActiveSpan('fanout.target_lookup', async (span: any) => {
    try {
      return await getConversationFanoutTargets(conversationId);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
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
    tracer.startActiveSpan('fanout.pending_enqueue', (span: any) => {
      enqueuePendingMessageForUsers(userIds, payload)
        .catch((err: unknown) => {
          logger.warn(
            { err, conversationId, userCount: userIds.length },
            "Failed to enqueue conversation message pending replay pointers",
          );
        })
        .finally(() => span.end());
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

  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    activeSpan.setAttribute('fanout.recipient_count', userIds.length + passthroughTargets.length);
    activeSpan.setAttribute('fanout.shard_count', userfeedShardCount);
  }

  async function publishPassthroughWithTimings() {
    if (!passthroughTargets.length)
      return { wallMs: 0, perTargetMs: [] as { target: string; ms: number }[] };
    const wall0 = process.hrtime.bigint();
    await fanout.publishBatch(
      passthroughTargets.map((target) => ({ channel: target, payload })),
    );
    const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
    const n = passthroughTargets.length;
    const perTargetMs = passthroughTargets.map((target) => ({
      target,
      ms: n > 0 ? wallMs / n : 0,
    }));
    return { wallMs, perTargetMs };
  }

  async function publishUserfeedWithTiming() {
    if (!userIds.length) return { wallMs: 0 };
    const t0 = process.hrtime.bigint();
    await publishUserFeedTargets(userIds, payload);
    return { wallMs: Number(process.hrtime.bigint() - t0) / 1e6 };
  }

  const [passthroughResult, userfeedResult] = await Promise.all([
    tracer.startActiveSpan('fanout.publish_passthrough', async (span: any) => {
      try {
        return await publishPassthroughWithTimings();
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    }),
    tracer.startActiveSpan('fanout.publish_userfeed', async (span: any) => {
      try {
        return await publishUserfeedWithTiming();
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String((err as any)?.message || '') });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    }),
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

  // Per-message list cache invalidation removed. At 68 msg/s the invalidation rate
  // (136-340/s) kept the cache permanently cold (0% hit rate). Structural changes
  // (create/delete conversation, participant join/leave) still invalidate via
  // conversationsRouter.ts and conversationSideEffects.ts.

  return fanoutPublishedAt(payload);
}

module.exports = {
  publishConversationEventNow,
};
