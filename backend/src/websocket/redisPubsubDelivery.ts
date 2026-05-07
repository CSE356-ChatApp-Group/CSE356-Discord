/**
 * Redis subscriber → local WebSocket delivery (direct topics, userfeed, communityfeed shards).
 */


const logger = require("../utils/logger");
const {
  fanoutRecipientsHistogram,
  realtimeMissAttributionTotal,
  wsActiveSubscriberTargetsBucket,
  wsFanoutRecoveryAsyncTotal,
  wsSocketSendTargetsBucket,
  wsPubsubReceiveLagMs,
  wsPubsubMessagesTotal,
  wsPubsubRecipientSlotsTotal,
  wsUserfeedEnvelopeUsersTotal,
  wsUserfeedLocalRecipientsTotal,
  wsDuplicateDeliverySuppressedTotal,
  wsDedupeEnqueueReservedTotal,
  wsDedupeSendConfirmedTotal,
  wsDedupeSendFailedTotal,
} = require("../utils/metrics");
const { parsePayloadReferenceTimeMs } = require("./outboundPayload");
const { getWorkerLabels } = require("./deliveryTrace");
const {
  publishUserFeedTargets,
  isUserFeedEnvelope,
  isUserFeedWorkerChannel,
  userFeedRouteLabelForChannel,
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
  hasDeliveryRiskReason,
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
    enqueuePendingMessageForUsers = null,
  } = ctx;
  const anonymousSocketIds = new WeakMap();
  let nextAnonymousSocketId = 0;
  const STALE_MAP_RECOVERY_MAX_USERS = 100;

  function reliableMessageId(parsed) {
    if (!isPlainJsonObject(parsed)) return null;
    const event = parsed.event;
    if (typeof event !== "string" || !event.startsWith("message:")) return null;
    const data = parsed.data;
    if (!isPlainJsonObject(data)) return null;
    const id = data.id || data.messageId || data.message_id;
    return typeof id === "string" && id ? id : null;
  }

  function reliableMessageEvent(parsed) {
    if (!isPlainJsonObject(parsed)) return null;
    const event = parsed.event;
    return typeof event === "string" && event.startsWith("message:") ? event : null;
  }

  function isPlainJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function extractChannelType(channel) {
    const colonIdx = channel.indexOf(":");
    return colonIdx > 0 ? channel.substring(0, colonIdx) : "unknown";
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

  function workerLabels() {
    return getWorkerLabels();
  }

  function observePubsubLagForPayload(topicPrefix, payload, pubsubReceiveMs) {
    if (!isPlainJsonObject(payload) || pubsubReceiveMs == null) return;
    const refMs = parsePayloadReferenceTimeMs(payload);
    if (refMs == null) return;
    const lagMs = pubsubReceiveMs - refMs;
    if (lagMs < 0 || lagMs >= 3_600_000) return;
    const wl = workerLabels();
    wsPubsubReceiveLagMs?.observe?.(
      { topic_prefix: topicPrefix, vm: wl.vm, worker: wl.worker },
      lagMs,
    );
  }

  function incWithWorker(metric, labels, count = 1) {
    const wl = workerLabels();
    metric?.inc?.({ ...labels, vm: wl.vm, worker: wl.worker }, count);
  }

  function recordDuplicateSuppression(path, reason, count = 1) {
    if (!count || count <= 0) return;
    wsDuplicateDeliverySuppressedTotal?.inc?.(
      { path, reason, ...workerLabels() },
      count,
    );
  }

  function recordDuplicateSuppressionReasons(path, reasonCounts) {
    const counts = reasonCounts || {};
    for (const reason in counts) {
      const count = Number(counts[reason]) || 0;
      if (count <= 0) continue;
      if (reason === "duplicate_candidate") {
        recordDuplicateSuppression(path, reason, count);
      }
    }
  }

  function recordPartialReasons(reasonCounts) {
    const counts = reasonCounts || {};
    const keys = Object.keys(counts);
    if (!keys.length) {
      wsPartialDeliveryMissingReasonTotal?.inc?.({ reason: "unknown" });
      return true;
    }
    const mapped = {};
    const add = (reason, count) => {
      mapped[reason] = (mapped[reason] || 0) + count;
    };
    for (const rawReason of keys) {
      const count = Number(counts[rawReason]) || 0;
      if (count <= 0) continue;
      if (
        rawReason === "dedupe_skip"
        || rawReason === "dedupe_recent_delivery"
        || rawReason === "duplicate_candidate"
      ) {
        // Duplicate suppression is informational. It is not a missing
        // recipient unless a non-dedupe delivery-risk reason is also present.
        continue;
      } else if (rawReason === "not_open" || rawReason === "waiters_overflow_terminated") {
        add("socket_not_open", count);
      } else if (rawReason === "best_effort_queue_drop" || rawReason === "backpressure_drop") {
        add("backpressure_drop", count);
      } else if (rawReason === "backpressure_kill") {
        add("socket_not_open", count);
      } else if (rawReason === "logical_suppressed") {
        add("not_subscribed", count);
      } else if (rawReason === "reconnecting") {
        add("reconnecting", count);
      } else if (rawReason === "send_failed") {
        add("send_failed", count);
      } else if (rawReason === "enqueue_failed") {
        add("enqueue_failed", count);
      } else if (rawReason === "no_socket") {
        add("no_socket", count);
      } else if (rawReason === "stale_map_miss") {
        add("stale_map_miss", count);
      } else {
        add("unknown", count);
      }
    }
    const mappedKeys = Object.keys(mapped);
    if (!mappedKeys.length) {
      return false;
    }
    for (const reason of mappedKeys) {
      wsPartialDeliveryMissingReasonTotal?.inc?.({ reason }, mapped[reason]);
    }
    return true;
  }

  function sendReliablePayloadToSocket(ws, logicalChannel, parsed, rawMessage, options: any = {}) {
    const messageId = reliableMessageId(parsed);
    const messageEvent = reliableMessageEvent(parsed);
    const userId = typeof ws?._userId === "string" ? ws._userId : null;
    const connectionId = socketDedupeId(ws);
    const path = options.dedupePath || dedupePathForChannelType(extractChannelType(logicalChannel || ""));
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
      recordDuplicateSuppression(path, "dedupe_skip");
      return false;
    }
    const shouldReserve = Boolean(messageId && messageEvent && userId && !allowedInCurrentBatch);
    const reservationToken = shouldReserve
      ? fanoutRecipientDedupe?.reserveRecipient?.(messageId, userId, path, messageEvent, connectionId)
      : null;
    if (reservationToken) {
      incWithWorker(wsDedupeEnqueueReservedTotal, { path });
    }
    const releaseReservation = (reason, recordAsyncMissing = false) => {
      if (!reservationToken || !messageId || !messageEvent || !userId) return;
      if (fanoutRecipientDedupe?.releaseRecipient?.(messageId, userId, messageEvent, connectionId, reservationToken)) {
        incWithWorker(wsDedupeSendFailedTotal, { path });
        if (recordAsyncMissing) {
          recordPartialReasons({ [reason || "send_failed"]: 1 });
        }
      }
    };
    const ok = sendPayloadToSocket(ws, logicalChannel, parsed, rawMessage, {
      ...options,
      onReliableSendConfirmed: () => {
        if (!reservationToken || !messageId || !messageEvent || !userId) return;
        if (fanoutRecipientDedupe?.confirmRecipient?.(messageId, userId, messageEvent, connectionId, reservationToken)) {
          incWithWorker(wsDedupeSendConfirmedTotal, { path });
        }
      },
      onReliableSendFailed: (reason) => {
        releaseReservation(reason || "send_failed", true);
      },
    });
    if (ok && reservationToken) {
      if (batchAllowKey) options.dedupeBatchAllowSet?.add?.(batchAllowKey);
    } else if (!ok && reservationToken) {
      releaseReservation("enqueue_failed", false);
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
    const recoveredUserIds = new Set();
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) continue;
      const uid = ws._userId;
      // CLOSING = clean disconnect in progress; 'close' will fire imminently and run cleanup.
      // The pending mailbox (written before channel PUBLISH) covers reconnect replay for these users.
      // Only request userfeed recovery for CLOSED/CONNECTING sockets, which indicate an
      // unexpected state where the normal cleanup path may not have run.
      if (ws.readyState !== WebSocket.CLOSING && typeof uid === "string" && uid.trim()) {
        recoveredUserIds.add(uid.trim());
      }
      unsubscribeClient(ws, topicChannel).catch((err) => {
        logger.warn({ err, topicChannel, userId: uid }, "WS prune: unsubscribeClient failed");
      });
    }
    return recoveredUserIds.size ? Array.from(recoveredUserIds) : [];
  }

  function pruneNonOpenFromCommunitySubscribers(communityId, clients) {
    if (!clients || clients.size === 0) return;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) continue;
      unsubscribeCommunityClient(ws, communityId);
    }
  }

  async function userfeedRecoveryAfterStaleTopicMap(channel, parsed, userIds) {
    if (!userIds.length || parsed === null || typeof parsed !== "object") return false;
    const ev = parsed.event;
    if (typeof ev !== "string" || !ev.startsWith("message:")) return false;
    const deduped = new Set(userIds);
    const all = Array.from(deduped);
    const cappedUserIds =
      all.length > STALE_MAP_RECOVERY_MAX_USERS
        ? all.slice(0, STALE_MAP_RECOVERY_MAX_USERS)
        : all;
    if (!cappedUserIds.length) return false;
    try {
      await publishUserFeedTargets(
        cappedUserIds.map((id) => `user:${id}`),
        parsed,
      );
      realtimeMissAttributionTotal.inc(
        { reason: "channel_topic_stale_map_userfeed_recovery" },
        cappedUserIds.length,
      );
      wsFanoutRecoveryAsyncTotal?.inc?.(
        { reason: "channel_topic_stale_map_userfeed_recovery" },
        cappedUserIds.length,
      );
      recordRealtimeMissAttribution(
        "channel_topic_stale_map_userfeed_recovery",
        cappedUserIds.length,
      );
      // Also write to the pending mailbox so a user who is between connections
      // (userfeed PUBLISH lands with 0 local clients) can still recover on reconnect.
      if (enqueuePendingMessageForUsers) {
        enqueuePendingMessageForUsers(cappedUserIds, parsed, {}).catch((err) => {
          logger.warn(
            { err, channel, userIdCount: cappedUserIds.length },
            "WS pending enqueue after stale topic recovery failed",
          );
        });
      }
      return true;
    } catch (err) {
      logger.warn(
        { err, channel, userIds },
        "WS userfeed recovery after stale topic subscribers failed",
      );
      return false;
    }
  }

  function scheduleUserfeedRecoveryAfterStaleTopicMap(channel, parsed, userIds) {
    if (!userIds.length || parsed === null || typeof parsed !== "object") return false;
    const deduped = new Set(userIds);
    const all = Array.from(deduped);
    const cappedUserIds =
      all.length > STALE_MAP_RECOVERY_MAX_USERS
        ? all.slice(0, STALE_MAP_RECOVERY_MAX_USERS)
        : all;
    if (!cappedUserIds.length) return false;
    setImmediate(() => {
      userfeedRecoveryAfterStaleTopicMap(channel, parsed, cappedUserIds).catch((err) => {
        logger.warn(
          { err, channel, userIdCount: cappedUserIds.length },
          "WS userfeed recovery after stale topic subscribers failed",
        );
      });
    });
    return true;
  }

  async function deliverUserFeedMessage(channel, routed, pubsubReceiveMs: number | null = null) {
    const payload = routed.payload;
    const userIdsRaw = routed.__wsRoute.userIds || [];
    const userIdsSet = new Set();
    for (const value of userIdsRaw) {
      if (typeof value === "string") userIdsSet.add(value);
    }
    const userIds = Array.from(userIdsSet);
    const dedupeBatchAllowSet = new Set();
    if (!userIds.length) return;
    const routeLabel = userFeedRouteLabelForChannel(channel);
    const topicPrefix = isUserFeedWorkerChannel(channel) ? "userfeed_worker" : "userfeed";
    const wl = workerLabels();
    wsPubsubMessagesTotal?.inc?.({ topic_prefix: topicPrefix, shard: routeLabel, vm: wl.vm, worker: wl.worker });
    wsUserfeedEnvelopeUsersTotal?.inc?.({ shard: routeLabel, vm: wl.vm, worker: wl.worker }, userIds.length);
    observePubsubLagForPayload(topicPrefix, payload, pubsubReceiveMs);

    let recipientCount = 0;
    for (const userId of userIds) {
      recipientCount += localUserClients.get(userId)?.size || 0;
    }
    fanoutRecipientsHistogram.observe({ channel_type: "user" }, recipientCount);
    wsSocketSendTargetsBucket?.observe?.({ path: "userfeed" }, recipientCount);
    wsPubsubRecipientSlotsTotal?.inc?.(
      { topic_prefix: topicPrefix, shard: routeLabel, vm: wl.vm, worker: wl.worker },
      recipientCount,
    );
    wsUserfeedLocalRecipientsTotal?.inc?.({ shard: routeLabel, vm: wl.vm, worker: wl.worker }, recipientCount);

    if (recipientCount === 0 && !logger.isLevelEnabled("debug")) return;

    const internalCommand = extractInternalUserFeedCommand(payload);
    const internalSubscribeChannels = internalCommand?.kind === "subscribe_channels"
      ? (() => {
        const channels = Array.isArray(internalCommand.channels) ? internalCommand.channels : [];
        const seen = new Set();
        const result = [];
        for (const value of channels) {
          if (typeof value !== "string") continue;
          if (!parseChannelKey(value)) continue;
          if (seen.has(value)) continue;
          seen.add(value);
          result.push(value);
        }
        return result;
      })()
      : null;
    const internalSubscribeCommunities = internalCommand?.kind === "subscribe_communities"
      ? (() => {
        const communityIds = Array.isArray(internalCommand.communityIds) ? internalCommand.communityIds : [];
        const seen = new Set();
        const result = [];
        for (const value of communityIds) {
          const normalized = normalizeCommunityTopic(value);
          if (typeof normalized !== "string") continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          result.push(normalized);
        }
        return result;
      })()
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
              pubsubReceiveMs,
            });
          }
          continue;
        }
        if (internalSubscribeCommunities) {
          const results = await Promise.allSettled(
            internalSubscribeCommunities.map((communityId) => subscribeCommunityClient(ws, communityId)),
          );
          const failed = results.find((r) => r.status === "rejected");
          if (failed && failed.status === "rejected") {
            logger.warn(
              { err: failed.reason, userId, communityCount: internalSubscribeCommunities.length },
              "WS internal community auto-subscribe command failed",
            );
          }
          if (ws.readyState === WebSocket.OPEN) {
            sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
              preparedPayload,
              dedupePath: "user_topic",
              dedupeBatchAllowSet,
              pubsubReceiveMs,
            });
          }
          continue;
        }

        sendReliablePayloadToSocket(ws, logicalChannel, payload, null, {
          preparedPayload,
          dedupePath: "user_topic",
          dedupeBatchAllowSet,
          pubsubReceiveMs,
        });
      }
    }
  }

  function deliverCommunityFeedMessage(channel, routed, pubsubReceiveMs: number | null = null) {
    const communityId = routed.__wsRoute.communityId;
    if (typeof communityId !== "string" || !communityId) return;
    const clients = communityClients.get(communityId);
    const recipientCount = clients ? clients.size : 0;
    const wl = workerLabels();
    fanoutRecipientsHistogram.observe({ channel_type: "communityfeed" }, recipientCount);
    wsSocketSendTargetsBucket?.observe?.({ path: "communityfeed" }, recipientCount);
    wsPubsubMessagesTotal?.inc?.(
      { topic_prefix: "communityfeed", shard: "none", vm: wl.vm, worker: wl.worker },
      1,
    );
    wsPubsubRecipientSlotsTotal?.inc?.(
      { topic_prefix: "communityfeed", shard: "none", vm: wl.vm, worker: wl.worker },
      recipientCount,
    );
    observePubsubLagForPayload("communityfeed", routed.payload, pubsubReceiveMs);
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
    let liveFanoutPendingMarked = false;
    const markLiveFanoutPending = () => {
      if (liveFanoutPendingMarked) return;
      signalLiveFanoutPending?.();
      liveFanoutPendingMarked = true;
    };

    const pubsubReceiveMs = Date.now();
    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // Bail early if message is not valid JSON
    }

    try {
      if (USER_FEED_SHARD_CHANNEL_SET.has(channel) || isUserFeedWorkerChannel(channel)) {
        if (isUserFeedEnvelope(parsed)) {
          const payloadEvent = parsed?.payload?.event;
          if (typeof payloadEvent === "string" && payloadEvent.startsWith("message:")) {
            markLiveFanoutPending();
          }
          await deliverUserFeedMessage(channel, parsed, pubsubReceiveMs);
        }
        return;
      }

      if (COMMUNITY_FEED_SHARD_CHANNEL_SET.has(channel)) {
        if (isCommunityFeedEnvelope(parsed)) {
          deliverCommunityFeedMessage(channel, parsed, pubsubReceiveMs);
        }
        return;
      }

      const channelType = extractChannelType(channel);
      const clients = recipientClientsForChannel(channel);
      const recipientCount = clients ? clients.size : 0;
      const wl = workerLabels();
      fanoutRecipientsHistogram.observe(
        { channel_type: channelType },
        recipientCount,
      );
      wsPubsubMessagesTotal?.inc?.(
        { topic_prefix: channelType, shard: "none", vm: wl.vm, worker: wl.worker },
        1,
      );
      wsPubsubRecipientSlotsTotal?.inc?.(
        { topic_prefix: channelType, shard: "none", vm: wl.vm, worker: wl.worker },
        recipientCount,
      );

      if (!clients || recipientCount === 0) {
        if (!logger.isLevelEnabled("debug")) return;
      }

      const parsedEvent =
        isPlainJsonObject(parsed)
          ? parsed.event
          : null;
      const isMessageEvent = typeof parsedEvent === "string" && parsedEvent.startsWith("message:");
      if (recipientCount > 0 && isMessageEvent && (channelType === "channel" || channelType === "conversation" || channelType === "user")) {
        markLiveFanoutPending();
      }

      // Observe pubsub receive lag (created_at → receive time) for message events.
      observePubsubLagForPayload(channelType, parsed, pubsubReceiveMs);

    if (channelType === "conversation" && logger.isLevelEnabled("debug")) {
      if (isMessageEvent) {
        const messageId = isPlainJsonObject(parsed) ? parsed.data?.id : null;
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
        scheduleUserfeedRecoveryAfterStaleTopicMap(channel, parsed, staleTopicRecoveryUserIds);
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
          pubsubReceiveMs,
        })) {
          deliveredCount += 1;
        }
      }

      const isReliableChannelMsg =
        isMessageEvent
        && (channelType === "channel" || channelType === "conversation");
      if (isReliableChannelMsg) {
        const hasPartialRisk =
          deliveredCount < openRecipientSlots && hasDeliveryRiskReason(reasonCounts);
        const recoveredFromStaleTopicMap =
          staleTopicRecoveryUserIds.length > 0
          && parsed !== null
          && scheduleUserfeedRecoveryAfterStaleTopicMap(channel, parsed, staleTopicRecoveryUserIds);
        if (deliveredCount === 0 && isDuplicateSuppressionOnly(reasonCounts)) {
          recordDuplicateSuppressionReasons(dedupePathForChannelType(channelType), reasonCounts);
          if (logger.isLevelEnabled("debug")) {
            const messageId =
              isPlainJsonObject(parsed)
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
        if (deliveredCount === 0 && !recoveredFromStaleTopicMap) {
          realtimeMissAttributionTotal.inc({ reason: "topic_message_send_blocked" });
          recordRealtimeMissAttribution("topic_message_send_blocked");
          recordPartialReasons(reasonCounts);
          const messageId =
            isPlainJsonObject(parsed)
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
        } else if (hasPartialRisk) {
          realtimeMissAttributionTotal.inc({ reason: "topic_message_partial_delivery" });
          recordRealtimeMissAttribution("topic_message_partial_delivery");
          recordPartialReasons(reasonCounts);
          recordDuplicateSuppressionReasons(dedupePathForChannelType(channelType), reasonCounts);
        } else if (deliveredCount < openRecipientSlots) {
          // Dedupe-only skips mean another valid path already handled the same
          // socket/message. Keep this informational; partial delivery remains
          // reserved for probable real misses.
          recordDuplicateSuppressionReasons(dedupePathForChannelType(channelType), reasonCounts);
        }
      }
    } finally {
      if (liveFanoutPendingMarked) {
        releaseLiveFanoutPending?.();
      }
    }
  }

  return { deliverPubsubMessage };
}

module.exports = { createRedisPubsubDelivery };
