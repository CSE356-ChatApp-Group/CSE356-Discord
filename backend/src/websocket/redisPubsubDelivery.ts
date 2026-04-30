/**
 * Redis subscriber → local WebSocket delivery (direct topics, userfeed, communityfeed shards).
 */


const logger = require("../utils/logger");
const {
  fanoutRecipientsHistogram,
  realtimeMissAttributionTotal,
} = require("../utils/metrics");
const {
  publishUserFeedTargets,
  isUserFeedEnvelope,
  userIdFromTarget,
} = require("./userFeed");
const { isCommunityFeedEnvelope } = require("./communityFeed");
const {
  prepareSocketPayload,
  extractInternalUserFeedCommand,
} = require("./outboundPayload");

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
  } = ctx;

  function recipientClientsForChannel(channel) {
    const userId = userIdFromTarget(channel);
    if (channel.startsWith("user:") && userId) {
      return localUserClients.get(userId) || null;
    }
    return channelClients.get(channel) || null;
  }

  function normalizeCommunityTopic(value) {
    if (typeof value !== "string") return null;
    const parsed = parseChannelKey(value.startsWith("community:") ? value : `community:${value}`);
    if (!parsed || parsed.type !== "community") return null;
    return parsed.id;
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
      return true;
    } catch (err) {
      logger.warn(
        { err, channel, userIds },
        "WS userfeed recovery after stale topic subscribers failed",
      );
      return false;
    }
  }

  function deliverUserFeedMessage(channel, routed) {
    const payload = routed.payload;
    const userIds = [...new Set(routed.__wsRoute.userIds.filter((value) => typeof value === "string"))];
    if (!userIds.length) return;

    let recipientCount = 0;
    for (const userId of userIds) {
      recipientCount += localUserClients.get(userId)?.size || 0;
    }
    fanoutRecipientsHistogram.observe({ channel_type: "user" }, recipientCount);

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
          Promise.allSettled(
            internalSubscribeChannels.map((targetChannel) => subscribeClient(ws, targetChannel)),
          ).catch((err) => {
            logger.warn(
              { err, userId, channelCount: internalSubscribeChannels.length },
              "WS internal auto-subscribe command failed",
            );
          });
          continue;
        }
        if (internalSubscribeCommunities) {
          for (const communityId of internalSubscribeCommunities) {
            subscribeCommunityClient(ws, communityId);
          }
          continue;
        }

        sendPayloadToSocket(ws, logicalChannel, payload, null, { preparedPayload });
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
    for (const ws of clients) {
      sendPayloadToSocket(ws, logicalChannel, payload, null, { preparedPayload });
    }
  }

  async function deliverPubsubMessage(channel, message) {
    if (USER_FEED_SHARD_CHANNEL_SET.has(channel)) {
      let routed = null;
      try {
        routed = JSON.parse(message);
      } catch {
        return;
      }
      if (isUserFeedEnvelope(routed)) {
        deliverUserFeedMessage(channel, routed);
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
    for (const ws of clients) {
      if (sendPayloadToSocket(ws, channel, parsed, message, { preparedPayload, debugReasonCounts: reasonCounts })) {
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
      let recovered = false;
      if (deliveredCount === 0 && staleTopicRecoveryUserIds.length > 0 && parsed !== null) {
        recovered = await userfeedRecoveryAfterStaleTopicMap(channel, parsed, staleTopicRecoveryUserIds);
      }
      if (deliveredCount === 0 && !recovered) {
        realtimeMissAttributionTotal.inc({ reason: "topic_message_send_blocked" });
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
      }
    }
  }

  return { deliverPubsubMessage };
}

module.exports = { createRedisPubsubDelivery };
