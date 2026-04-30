/**
 * POST /messages: after fanout — community signal, idempotency Redis, 201 body, traces, Meilisearch.
 * Log prefix: `POST /messages:` for grep.
 */


const logger = require("../../utils/logger");
const redis = require("../../db/redis");
const meiliClient = require("../../search/meiliClient");
const sideEffects = require("../sideEffects");
const { MSG_IDEM_SUCCESS_TTL_SECS } = require("../lib/idempotency");
const {
  buildMessagePostSlowHolderLog,
  shouldEmitPostMessagesE2eTrace,
  buildPostMessagesE2eTracePayload,
} = require("../lib/postDiagnostics");
const { messagePostAsyncFanoutEnabled } = require("./postConstants");

function runPostSuccessFollowup(opts: {
  req: { id?: string; body: { channelId?: unknown } };
  res: import("express").Response;
  channelId: string | null;
  conversationId: string | null;
  communityId: string | null;
  baseMessage: { id: string; author_id: string; created_at: string | Date };
  message: any;
  idemRedisKey: string | null;
  idemLease: boolean;
  realtimePublishedAtForHttp: string | undefined;
  realtimeChannelFanoutComplete: boolean;
  realtimeConversationFanoutComplete: boolean;
  postWallStart: number;
  txPhases: { t0: number; t_access: number; t_insert: number; t_later: number };
  idemWallMs: number;
  channelInsertLockWaitMs: number;
  channelInsertLockPath: string | null;
  channelInsertLockReasonDetail: unknown;
  postMessagesTxPhaseLog: Record<string, unknown> | null;
  t_tx_done: number;
  hydrateWallMs: number;
  tAfterHydrateMark: number;
  t_after_cache_bust: number;
  t_after_fanout: number;
  fanoutMeta: any;
}) {
  const {
    req,
    res,
    channelId,
    conversationId,
    communityId,
    baseMessage,
    message,
    idemRedisKey,
    idemLease,
    realtimePublishedAtForHttp: rtpIn,
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
  } = opts;

  let realtimePublishedAtForHttp = rtpIn;
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
  const t_after_side_effects = Date.now();

  const userFanoutDeferred =
    !!channelId &&
    (!realtimeChannelFanoutComplete ||
      process.env.MESSAGE_USER_FANOUT_HTTP_BLOCKING === "false" ||
      process.env.MESSAGE_USER_FANOUT_HTTP_BLOCKING === "0");

  if (idemRedisKey && idemLease) {
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
  const t_after_idem_cache = Date.now();

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
    if (postMessagesTxPhaseLog && (postMessagesTxPhaseLog as any).tx_total_ms > 1000) {
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

  if (meiliClient.isEnabled() && message.id) {
    setImmediate(() => {
      meiliClient.indexMessage({
        id: message.id,
        content: message.content || "",
        authorId: message.author_id,
        channelId: message.channel_id || null,
        communityId: communityId || null,
        conversationId: message.conversation_id || null,
        createdAt: new Date(message.created_at).getTime(),
        updatedAt: null,
      }).catch(() => {});
    });
  }
}

module.exports = { runPostSuccessFollowup };
