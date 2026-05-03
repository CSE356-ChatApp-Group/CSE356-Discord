/**
 * Redis subscriber → local WebSocket delivery (direct topics, userfeed, communityfeed shards).
 */


const logger = require("../utils/logger");
const {
  fanoutRecipientsHistogram,
  realtimeMissAttributionTotal,
  wsActiveSubscriberTargetsBucket,
  wsFanoutRecoveryInlineTotal,
  wsSocketSendTargetsBucket,
} = require("../utils/metrics");
const {
  publishUserFeedTargets,
  isUserFeedEnvelope,
  userIdFromTarget,
} = require("./userFeed");
const {
  recordRealtimeMissAttribution,
} = require("./wsDeliveryPressure");
const { isCommunityFeedEnvelope } = require("./communityFeed");
const {
  prepareSocketPayload,
  extractInternalUserFeedCommand,
} = require("./outboundPayload");
const {
  normalizeCommunityTopic,
  isDuplicateSuppressionOnly,
} = require("./redisPubsubTopicUtils");

/**
 * @param ctx - Closed-over server wiring (maps, subscribe helpers, sendPayloadToSocket).
 */
function createRedisPubsubDelivery(ctx) {
  const {
    WebSocket,
    channelClients,
    localUserClients,
    communityClients,
    USER_FEED_SHARD_CHANNEL_SET,
    COMMUNITY_FEED_SHARD_CHANNEL_SET,
    subscribeClient,
    unsubscribeClient,
    subscribeCommunityClient,
    unsubscribeCommunityClient,
    parseChannelKey,
    sendPayloadToSocket,
    fanoutRecipientDedupe = null,
    wsPartialDeliveryMissingReasonTotal = null,
    signalLiveFanoutPending = null,
    releaseLiveFanoutPending = null,
  } = ctx;
  const anonymousSocketIds = new WeakMap();
  let nextAnonymousSocketId = 0;

  function reliableMessageId(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed.event;
    if (typeof event !== "string" || !event.startsWith("message:")) return null;
    const data = parsed.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const id = data.id || data.messageId || data.message_id;
    return typeof id === "string" && id ? id : null;
  }

  function reliableMessageEvent(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const event = parsed.event;
    return typeof event === "string" && event.startsWith("message:") ? event : null;
  }

  function dedupePathForChannelType(channelType) {
    if (channelType === "user") return "user_topic";
    if (channelType === "channel" || channelType === "conversation") return "channel_topic";
    return "other";
  }

  function socketDedupeId(ws) {
    if (typeof ws?._connectionId === "string" && ws._connectionId) return ws._connectionId;
    if (!ws || (typeof ws !== "object" && typeof ws !== "function")) return "unknown";
    let id = anonymousSocketIds.get(ws);
    if (!id) {
      nextAnonymousSocketId += 1;
      id = `anon:${nextAnonymousSocketId}`;
      anonymousSocketIds.set(ws, id);
    }
    return id;
  }

  function recordPartialReasons(reasonCounts) {
    const entries = Object.entries(reasonCounts || {});
    if (!entries.length) {
      wsPartialDeliveryMissingReasonTotal?.inc?.({ reason: "unknown" });
      return;
    }
    const mapped = {};
    const add = (reason, count) => {
      mapped[reason] = (mapped[reason] || 0) + count;
    };
    for (const [rawReason, rawCount] of entries) {
      const count = Number(rawCount) || 0;
      if (count <= 0) continue;
      if (rawReason === "dedupe_skip" || rawReason === "dedupe_recent_delivery") {
        add("dedupe_skip", count);
      } else if (rawReason === "not_open" || rawReason === "waiters_overflow_terminated") {
        add("socket_not_open", count);
      } else if (rawReason === "best_effort_queue_drop") {
        add("backpressure_drop", count);
      } else if (rawReason === "logical_suppressed") {
        add("not_subscribed", count);
      } else if (rawReason === "reconnecting") {
        add("reconnecting", count);
      } else {
        add("unknown", count);
      }
    }
    if (!Object.keys(mapped).length) {
      wsPartialDeliveryMissingReasonTotal?.inc?.({ reason: "unknown" });
      return;
    }
    for (const [reason, count] of Object.entries(mapped)) {
      wsPartialDeliveryMissingReasonTotal?.inc?.({ reason }, count);
    }
  }

  function sendReliablePayloadToSocket(ws, logicalChannel, parsed, rawMessage, options: any = {}) {
    const messageId = reliableMessageId(parsed);
    const messageEvent = reliableMessageEvent(parsed);
    const userId = typeof ws?._userId === "string" ? ws._userId : null;
    const connectionId = socketDedupeId(ws);
    const path = options.dedupePath || dedupePathForChannelType((logicalChannel || "").split(":")[0] || "unknown");
    const reasonCounts = options.debugReasonCounts || null;
    const batchAllowKey = messageId && messageEvent && userId
      ? `${messageEvent}:${messageId}:${userId}:${connectionId}`
      : null;
    const allowedInCurrentBatch = Boolean(batchAllowKey && options.dedupeBatchAllowSet?.has?.(batchAllowKey));
    if (
      messageId
      && messageEvent
      && userId
      && !allowedInCurrentBatch
      && fanoutRecipientDedupe?.hasSeenRecipient?.(messageId, userId, messageEvent, connectionId)
    ) {
      if (reasonCounts) reasonCounts.dedupe_skip = (reasonCounts.dedupe_skip || 0) + 1;
      fanoutRecipientDedupe.markDuplicateRecipient?.(messageId, userId, path, messageEvent);
      return false;
    }
    const ok = sendPayloadToSocket(ws, logicalChannel, parsed, rawMessage, options);
    if (ok && messageId && messageEvent && userId && !allowedInCurrentBatch) {
      fanoutRecipientDedupe?.markRecipient?.(messageId, userId, path, messageEvent, connectionId);
      if (batchAllowKey) options.dedupeBatchAllowSet?.add?.(batchAllowKey);
    }
    return ok;
  }

  function recipientClientsForChannel(channel) {
    const userId = userIdFromTarget(channel);
    if (channel.startsWith("user:") && userId) {
      return localUserClients.get(userId) || null;
    }
    return channelClients.get(channel) || null;
  }

  function pruneNonOpenSocketsFromLocalTopicSubscribers(topicChannel, clients) {
    if (!clients || clients.size === 0) return [];
    const recoveredUserIds = [];
    for (const ws of [...clients]) {
      if (ws.readyState === WebSocket.OPEN) continue;
      const uid = ws._userId;
      if (typeof uid === "string" && uid.trim()) recoveredUserIds.push(uid.trim());
      unsubscribeClient(ws, topicChannel).catch((err) => {
        logger.warn({ err, topicChannel, userId: uid }, "WS prune: unsubscribeClient failed");
      });
    }
    return [...new Set(recoveredUserIds)];
  }

  function pruneNonOpenFromCommunitySubscribers(communityId, clients) {
    if (!clients || clients.size === 0) return;
    for (const ws of [...clients]) {
      if (ws.readyState === WebSocket.OPEN) continue;
      unsubscribeCommunityClient(ws, communityId);
    }
  }

  async function userfeedRecoveryAfterStaleTopicMap(channel, parsed, userIds) {
    if (!userIds.length || parsed === null || typeof parsed !== "object") return false;
    const ev = parsed.event;
    if (typeof ev !== "string" || !ev.startsWith("message:")) return false;
    try {
      await publishUserFeedTargets(
        userIds.map((id) => `user:${id}`),
        parsed,
      );
      realtimeMissAttributionTotal.inc(
        { reason: "channel_topic_stale_map_userfeed_recovery" },
        userIds.length,
      );
      recordRealtimeMissAttribution(
        "channel_topic_stale_map_userfeed_recovery",
        userIds.length,
      );
      wsFanoutRecoveryInlineTotal?.inc?.(
        { reason: "channel_topic_stale_map_userfeed_recovery" },
        userIds.length,
      );
      return true;
    } catch (err) {
      logger.warn(
        { err, channel, userIds },
        "WS userfeed recovery after stale topic subscribers failed",
      );
      return false;
    }
  }

  async function deliverUserFeedMessage(channel, routed) {
    const payload = routed.payload;
    const userIds = [...new Set(routed.__wsRoute.userIds.filter((value) => typeof value === "string"))];
    const dedupeBatchAllowSet = new Set();
    if (!userIds.length) return;

    let recipientCount = 0;
    for (const userId of userIds) {
      recipientCount += localUserClients.get(userId)?.size || 0;
    }
    fanoutRecipientsHistogram.observe({ channel_type: "user" }, recipientCount);
    wsSocketSendTargetsBucket?.observe?.({ path: "user_topic" }, recipientCount);

    if (recipientCount === 0 && !logger.isLevelEnabled("debug")) return;

    const internalCommand = extractInternalUserFeedCommand(payload);
    const internalSubscribeChannels = internalCommand?.kind === "subscribe_channels"
      ? [...new Set(
        (Array.isArray(internalCommand.channels) ? internalCommand.channels : [])
          .filter((value) => typeof value === "string")
          .filter((value) => parseChannelKey(value)),
      )]
      : null;
    const internalSubscribeCommunities = internalCommand?.kind === "subscribe_communities"
      ? [...new Set(
        (Array.isArray(internalCommand.communityIds) ? internalCommand.communityIds : [])
          .map((value) => normalizeCommunityTopic(value))
          .filter((value) => typeof value === "string"),
      )]
      : null;

    const payloadEvent = payload?.event;
    const isMessageEvent = typeof payloadEvent === "string" && payloadEvent.startsWith("message:");
    if (isMessageEvent && logger.isLevelEnabled("debug")) {
      logger.debug(
        {
          channel,
          event: payloadEvent,
          messageId: payload?.data?.id,
          userIdCount: userIds.length,
          recipientCount,
        },
        recipientCount > 0
          ? "WS userfeed: delivering message to local clients"
          : "WS userfeed: no local clients for message event",
      );
    }

    if (recipientCount === 0) return;

    for (const userId of userIds) {
      const clients = localUserClients.get(userId);
      if (!clients || clients.size === 0) continue;
      const logicalChannel = `user:${userId}`;
      pruneNonOpenSocketsFromLocalTopicSubscribers(logicalChannel, clients);
      if (!clients.size) continue;
      const preparedPayload = prepareSocketPayload(logicalChannel, payload, null);
      for (const ws of clients) {
        if (internalSubscribeChannels) {
          if (!internalSubscribeChannels.length) continue;
          const results = await Promise.allSettled(
            internalSubscribeChannels.map((targetChannel) => subscribeClient(ws, targetChannel)),
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed && failed.status === "rejected") {
            logger.warn(
              { err: failed.reason, userId, channelCount: internalSubscribeChannels.length },
              "WS internal auto-subscribe command failed",
            );
          }
          if (ws.readyState === WebSocket.OPEN) {
            sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
              preparedPayload,
              dedupePath: "user_topic",
              dedupeBatchAllowSet,
            });
          }
          continue;
        }
        if (internalSubscribeCommunities) {
          for (const communityId of internalSubscribeCommunities) {
            subscribeCommunityClient(ws, communityId);
          }
          if (ws.readyState === WebSocket.OPEN) {
            sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
              preparedPayload,
              dedupePath: "user_topic",
              dedupeBatchAllowSet,
            });
          }
          continue;
        }

        sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
          preparedPayload,
          dedupePath: "user_topic",
          dedupeBatchAllowSet,
        });
      }
    }
  }

  function deliverCommunityFeedMessage(channel, routed) {
    const communityId = routed.__wsRoute.communityId;
    if (typeof communityId !== "string" || !communityId) return;
    const clients = communityClients.get(communityId);
    const recipientCount = clients ? clients.size : 0;
    fanoutRecipientsHistogram.observe({ channel_type: "communityfeed" }, recipientCount);
    if (!clients || recipientCount === 0) return;

    pruneNonOpenFromCommunitySubscribers(communityId, clients);
    if (!clients.size) return;

    const payload = routed.payload;
    const logicalChannel = `community:${communityId}`;
    const preparedPayload = prepareSocketPayload(logicalChannel, payload, null);
    const dedupeBatchAllowSet = new Set();
    for (const ws of clients) {
      sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
        preparedPayload,
        dedupeBatchAllowSet,
      });
    }
  }

  async function deliverPubsubMessage(channel, message) {
    signalLiveFanoutPending?.();
    try {
      if (USER_FEED_SHARD_CHANNEL_SET.has(channel)) {
        let routed = null;
        try {
          routed = JSON.parse(message);
        } catch {
          return;
        }
        if (isUserFeedEnvelope(routed)) {
          await deliverUserFeedMessage(channel, routed);
        }
        return;
      }

      if (COMMUNITY_FEED_SHARD_CHANNEL_SET.has(channel)) {
        let routed = null;
        try {
          routed = JSON.parse(message);
        } catch {
          return;
        }
        if (isCommunityFeedEnvelope(routed)) {
          deliverCommunityFeedMessage(channel, routed);
        }
        return;
      }

      const clients = recipientClientsForChannel(channel);
      const recipientCount = clients ? clients.size : 0;
      const channelType = channel.split(":")[0] || "unknown";
      fanoutRecipientsHistogram.observe(
        { channel_type: channelType },
        recipientCount,
      );
      if (channelType === "channel" || channelType === "conversation") {
        const metricPath = channelType === "channel" ? "channel_message" : "conversation_event";
        wsActiveSubscriberTargetsBucket?.observe?.({ path: metricPath }, recipientCount);
        wsSocketSendTargetsBucket?.observe?.(
          { path: channelType === "channel" ? "channel_topic" : "conversation_topic" },
          recipientCount,
        );
      } else if (channelType === "user") {
        wsSocketSendTargetsBucket?.observe?.({ path: "user_topic" }, recipientCount);
      }

      if (!clients || recipientCount === 0) {
        if (!logger.isLevelEnabled("debug")) return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(message);
      } catch {
        /* ignore */
      }

    if (channelType === "conversation" && logger.isLevelEnabled("debug")) {
      const parsedEvent = parsed?.event;
      const isMessageEvent = typeof parsedEvent === "string" && parsedEvent.startsWith("message:");
      if (isMessageEvent) {
        const messageId = parsed?.data?.id;
        logger.debug(
          { channel, event: parsedEvent, messageId, recipientCount },
          recipientCount > 0
            ? "WS conversation channel: delivering message to subscribers"
            : "WS conversation channel: no subscribers for message event",
        );
      }
    }

    if (!clients || recipientCount === 0) return;

    let staleTopicRecoveryUserIds = [];
    if (channelType === "channel" || channelType === "conversation" || channelType === "user") {
      staleTopicRecoveryUserIds = pruneNonOpenSocketsFromLocalTopicSubscribers(channel, clients);
    }

    if (!clients.size) {
      if (
        (channelType === "channel" || channelType === "conversation")
        && staleTopicRecoveryUserIds.length > 0
        && parsed !== null
      ) {
        await userfeedRecoveryAfterStaleTopicMap(channel, parsed, staleTopicRecoveryUserIds);
      }
      return;
    }

    if (channelType === "user" && clients.size > 0 && parsed !== null && logger.isLevelEnabled("debug")) {
      logger.debug({
        event: "presence.fanout.delivered",
        channel,
        recipientCount: clients.size,
        payload: parsed,
      });
    }

    const openRecipientSlots = clients.size;
    const preparedPayload = prepareSocketPayload(channel, parsed, message);
    let deliveredCount = 0;
    const reasonCounts = {};
    const dedupeBatchAllowSet = new Set();
      for (const ws of clients) {
        if (sendReliablePayloadToSocket(ws, channel, parsed, message, {
          preparedPayload,
          debugReasonCounts: reasonCounts,
          dedupePath: dedupePathForChannelType(channelType),
          dedupeBatchAllowSet,
        })) {
          deliveredCount += 1;
        }
      }

      const parsedEvent =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed.event
          : null;
      const isReliableChannelMsg =
        typeof parsedEvent === "string"
        && parsedEvent.startsWith("message:")
        && (channelType === "channel" || channelType === "conversation");
      if (isReliableChannelMsg) {
        if (deliveredCount === 0 && isDuplicateSuppressionOnly(reasonCounts)) {
          recordPartialReasons(reasonCounts);
          if (logger.isLevelEnabled("debug")) {
            const messageId =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed.data
                : null;
            const resolvedMessageId = messageId?.id || messageId?.messageId || messageId?.message_id || null;
            logger.debug(
              {
                event: "ws.realtime_delivery_deduped",
                channel,
                channelType,
                parsedEvent,
                messageId: typeof resolvedMessageId === "string" ? resolvedMessageId : null,
                recipientCount,
                reasonCounts,
                delivery_target_kind: channelType,
                delivery_path: "live_pubsub",
              },
              "Reliable realtime message delivery skipped because another path already sent the same payload",
            );
          }
          return;
        }
        let recovered = false;
        if (deliveredCount === 0 && staleTopicRecoveryUserIds.length > 0 && parsed !== null) {
          recovered = await userfeedRecoveryAfterStaleTopicMap(channel, parsed, staleTopicRecoveryUserIds);
        }
        if (deliveredCount === 0 && !recovered) {
          realtimeMissAttributionTotal.inc({ reason: "topic_message_send_blocked" });
          recordRealtimeMissAttribution("topic_message_send_blocked");
          recordPartialReasons(reasonCounts);
          const messageId =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed.data
              : null;
          const resolvedMessageId = messageId?.id || messageId?.messageId || messageId?.message_id || null;
          logger.warn(
            {
              event: "ws.realtime_delivery_blocked",
              channel,
              channelType,
              parsedEvent,
              messageId: typeof resolvedMessageId === "string" ? resolvedMessageId : null,
              recipientCount,
              reasonCounts,
              staleTopicRecoveryUserIds,
              delivery_target_kind: channelType,
              delivery_path: "live_pubsub",
              gradingNote: "correlate_with_delivery_timeout_missing_recipient",
            },
            "Reliable realtime message had recipients but zero successful socket sends",
          );
        } else if (deliveredCount < openRecipientSlots) {
          realtimeMissAttributionTotal.inc({ reason: "topic_message_partial_delivery" });
          recordRealtimeMissAttribution("topic_message_partial_delivery");
          recordPartialReasons(reasonCounts);
        }
      }
    } finally {
      releaseLiveFanoutPending?.();
    }
  }

  return { deliverPubsubMessage };
}

module.exports = { createRedisPubsubDelivery };
