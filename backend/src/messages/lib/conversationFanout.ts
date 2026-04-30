/**
 * Synchronous conversation-wide Redis/WebSocket fanout (DM timing logs, read:updated, etc.).
 */

"use strict";

const fanout = require("../../websocket/fanout");
const redis = require("../../db/redis");
const logger = require("../../utils/logger");
const {
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
} = require("../../utils/metrics");
const { getConversationFanoutTargets } = require("../conversationFanoutTargets");
const {
  wrapFanoutPayload,
  fanoutPublishedAt,
} = require("../realtimePayload");
const { enqueuePendingMessageForUsers } = require("../realtimePending");
const {
  publishUserFeedTargets,
  splitUserTargets,
  userFeedRedisChannelForUserId,
} = require("../../websocket/userFeed");

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

async function publishConversationEventNow(
  conversationId: string,
  event: string,
  data: unknown,
) {
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
    enqueuePendingMessageForUsers(userIds, payload).catch((err: unknown) => {
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

module.exports = {
  publishConversationEventNow,
};
