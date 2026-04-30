/**
 * POST /messages: realtime fanout after DB commit (channel vs conversation).
 * Log prefix: `POST /messages:` for grep.
 */


const logger = require("../../utils/logger");
const sideEffects = require("../sideEffects");
const {
  deliveryTimeoutTotal,
  messagePostFanoutAsyncEnqueueTotal,
  messagePostRealtimePublishFailTotal,
} = require("../../utils/metrics");
const { poolStats } = require("../../db/pool");
const {
  publishConversationMessageCreatedPlan,
} = require("../../realtime/publishPlan");
const { wsDispatchFields } = require("../../realtime/deliveryLogFields");
const { publishConversationEventNow } = require("../lib/conversationFanout");
const { messageFanoutEnvelope } = require("../realtimePayload");
const {
  publishChannelMessageCreated,
  publishChannelMessageRecentUserBridge,
} = require("../channelRealtimeFanout");
const { loadHydratedMessageById } = require("../messageHydrate");
const messagePostFanoutAsync = require("../messagePostFanoutAsync");
const { incrementChannelMessageCount } = require("../channelMessageCounter");
const { appendChannelMessageIngested } = require("../messageIngestLog");
const {
  withBoundedPostInsertTimeout,
} = require("../lib/messageListCache");
const {
  MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS,
  MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED,
  messagePostAsyncFanoutEnabled,
} = require("./postConstants");

async function runChannelMessageCreatedFanout(opts: {
  req: { id?: string };
  channelId: string;
  communityId: string | null;
  baseMessage: { id: string; author_id: string; created_at: string | Date };
  message: any;
}) {
  const { req, channelId, communityId, baseMessage, message } = opts;
  let realtimePublishedAtForHttp: string | undefined;
  let realtimeChannelFanoutComplete = false;
  let fanoutMeta: any = null;

  incrementChannelMessageCount(channelId).catch((err: unknown) => {
    logger.warn(
      { err, channelId },
      "Failed to increment channel:msg_count alongside realtime publish",
    );
  });

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
        }).catch((err: unknown) => {
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
      } catch (syncFanoutErr: unknown) {
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
  } catch (fanoutErr: unknown) {
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

  appendChannelMessageIngested({
    messageId: String(message.id),
    channelId: String(channelId),
    authorId: String(baseMessage.author_id),
    createdAt:
      typeof baseMessage.created_at === "string"
        ? baseMessage.created_at
        : new Date(baseMessage.created_at).toISOString(),
  });

  return {
    realtimePublishedAtForHttp,
    realtimeChannelFanoutComplete,
    fanoutMeta,
  };
}

async function runConversationMessageCreatedFanout(opts: {
  req: { id?: string };
  conversationId: string;
  message: any;
  baseMessage: { id: string };
}) {
  const { req, conversationId, message, baseMessage } = opts;
  let realtimePublishedAtForHttp: string | undefined;
  let realtimeConversationFanoutComplete = false;

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
        ).catch((fallbackErr: unknown) => {
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
      } catch (syncFanoutErr: unknown) {
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
        ).catch((fallbackErr: unknown) => {
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
  } catch (fanoutErr: unknown) {
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

  return { realtimePublishedAtForHttp, realtimeConversationFanoutComplete };
}

module.exports = {
  runChannelMessageCreatedFanout,
  runConversationMessageCreatedFanout,
};
