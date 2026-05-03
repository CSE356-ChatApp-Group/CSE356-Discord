function createOutboundQueueHelpers({
  WebSocket,
  logger,
  noteRecentDisconnectForSocket,
  shouldSkipSocketForLogicalChannel,
  wasSocketMessageRecentlyDelivered,
  markSocketMessageDelivered,
  isReliableRealtimeEvent,
  wsDeliveryTopicPrefixForMetrics,
  parsePayloadReferenceTimeMs,
  prepareSocketPayload,
  wsBackpressureEventsTotal,
  wsOutboundQueueDepthHistogram,
  wsOutboundQueuedFramesGauge,
  wsOutboundQueueBlockWaitsTotal,
  wsOutboundQueueDroppedBestEffortTotal,
  wsOutboundDrainBatchesTotal,
  wsReliableDeliveryTotal,
  wsReliableDeliveryLatencyMs,
  wsReliableDeliveryTopicTotal,
  wsRecipientDedupeTotal,
  // optional new delivery-tracing metrics (null-safe throughout)
  wsDeliveryStageDurationMs = null,
  wsDeliverySlowTraceTotal = null,
  wsSocketQueueDepthHistogram = null,
  wsSocketSendDurationMs = null,
  WS_BACKPRESSURE_DROP_BYTES,
  WS_BACKPRESSURE_KILL_BYTES,
  WS_OUTBOUND_QUEUE_MAX_MESSAGE,
  WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT,
  WS_OUTBOUND_DRAIN_BATCH,
  WS_OUTBOUND_MESSAGE_WAITERS_MAX,
}) {
  const {
    recordWsReliableRealtimeLatencyMs,
  } = require("./wsDeliveryPressure");
  const { getWorkerLabels, emitSlowDeliveryTrace } = require("./deliveryTrace");

  function ensureOutboundQueue(ws) {
    if (!ws._outboundQueue) {
      ws._outboundQueue = [];
      ws._outboundDrainScheduled = false;
    }
    if (!ws._outMsgWaiters) {
      ws._outMsgWaiters = [];
    }
  }

  function adjustWsOutboundGauge(delta) {
    if (!delta) return;
    if (delta > 0) {
      wsOutboundQueuedFramesGauge.inc(delta);
    } else {
      wsOutboundQueuedFramesGauge.dec(-delta);
    }
  }

  function clearOutboundQueue(ws) {
    ensureOutboundQueue(ws);
    const q = ws._outboundQueue;
    const n = q.length;
    if (n > 0) {
      q.length = 0;
      adjustWsOutboundGauge(-n);
    }
    const waiters = ws._outMsgWaiters;
    if (waiters && waiters.length) {
      waiters.length = 0;
    }
  }

  function flushOutboundJob(ws, job) {
    const {
      logicalChannel,
      parsed,
      rawMessage,
      bypassLogicalDuplicateSuppression,
      preparedPayload,
      deliveryPath = "realtime",
      deliverySource = "live_pubsub",
      enqueueMs = null,
      pubsubReceiveMs = null,
    } = job;
    const flushStartMs = Date.now();
    const delivery_target_kind = wsDeliveryTopicPrefixForMetrics(logicalChannel);
    const delivery_path_kind = deliveryPath === "replay" ? "replay" : "realtime";
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!bypassLogicalDuplicateSuppression && shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed)) {
      return;
    }

    const resolvedPrepared =
      preparedPayload || prepareSocketPayload(logicalChannel, parsed, rawMessage);
    const {
      dedupeKey,
      outbound,
      payloadEventName,
      skipDropForBackpressure,
    } = resolvedPrepared;
    if (wasSocketMessageRecentlyDelivered(ws, dedupeKey)) {
      wsRecipientDedupeTotal?.inc?.({ path: delivery_target_kind });
      return;
    }

    const buffered = ws.bufferedAmount ?? 0;
    if (buffered >= WS_BACKPRESSURE_KILL_BYTES) {
      wsBackpressureEventsTotal.inc({ action: "kill" });
      logger.warn(
        {
          event: "ws.slow_consumer.killed",
          userId: ws._userId,
          buffered,
          redisChannel: logicalChannel,
          payloadEvent: payloadEventName,
          delivery_target_kind,
          delivery_path: delivery_path_kind,
          gradingNote: "correlate_with_failed_deliveries",
        },
        "WS slow consumer: terminating connection due to excessive backpressure",
      );
      noteRecentDisconnectForSocket(ws, 1006, "backpressure_kill");
      clearOutboundQueue(ws);
      ws.terminate();
      return;
    }
    if (!skipDropForBackpressure && buffered >= WS_BACKPRESSURE_DROP_BYTES) {
      wsBackpressureEventsTotal.inc({ action: "drop" });
      logger.warn(
        {
          event: "ws.slow_consumer.frame_dropped",
          userId: ws._userId,
          buffered,
          redisChannel: logicalChannel,
          payloadEvent: payloadEventName,
          delivery_target_kind,
          delivery_path: delivery_path_kind,
          gradingNote: "correlate_with_failed_deliveries",
        },
        "WS slow consumer: dropping frame due to backpressure",
      );
      return;
    }

    const isReliableEvent = !!(payloadEventName && isReliableRealtimeEvent(payloadEventName));
    const pathKind = deliveryPath === "replay" ? "replay" : "realtime";
    const sourceKind =
      pathKind === "replay"
        ? (deliverySource === "pending_queue" ? "pending_queue" : "missed_db")
        : "live_pubsub";
    const topicPrefix = wsDeliveryTopicPrefixForMetrics(logicalChannel);
    const refMs = isReliableEvent ? parsePayloadReferenceTimeMs(parsed) : null;

    // Enqueue-to-flush delay (time frame waited in queue before ws.send())
    const enqueueWaitMs = enqueueMs != null ? flushStartMs - enqueueMs : null;
    if (enqueueWaitMs != null && isReliableEvent) {
      const wl = getWorkerLabels();
      wsDeliveryStageDurationMs?.observe?.({ stage: 'socket_enqueue_wait', path: pathKind, vm: wl.vm, worker: wl.worker }, enqueueWaitMs);
    }

    const sendStartMs = Date.now();
    ws.send(outbound, (err) => {
      const sendDoneMs = Date.now();
      const sendDurationMs = sendDoneMs - sendStartMs;
      const wl = getWorkerLabels();
      wsSocketSendDurationMs?.observe?.({ vm: wl.vm, worker: wl.worker }, sendDurationMs);
      wsDeliveryStageDurationMs?.observe?.({ stage: 'socket_write', path: pathKind, vm: wl.vm, worker: wl.worker }, sendDurationMs);

      if (!err) {
        markSocketMessageDelivered(ws, dedupeKey);
        if (isReliableEvent) {
          wsReliableDeliveryTotal.inc({ path: pathKind, source: sourceKind });
          wsReliableDeliveryTopicTotal.inc({
            path: pathKind,
            topic_prefix: topicPrefix,
          });
          if (refMs != null) {
            const deltaMs = sendDoneMs - refMs;
            if (deltaMs >= 0 && Number.isFinite(deltaMs)) {
              wsReliableDeliveryLatencyMs.observe({ path: pathKind }, deltaMs);
              if (pathKind === "realtime") {
                recordWsReliableRealtimeLatencyMs(deltaMs);
              }
              // Slow delivery trace (realtime path only to avoid noisy replay logs)
              if (pathKind === "realtime") {
                const parsedData = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
                const msgId = parsedData?.data?.id ?? parsedData?.data?.messageId ?? null;
                const channelId = parsedData?.data?.channel_id ?? parsedData?.data?.channelId ?? null;
                const conversationId = parsedData?.data?.conversation_id ?? parsedData?.data?.conversationId ?? null;
                const senderUserId = parsedData?.data?.author_id ?? parsedData?.data?.senderId ?? null;
                const recipientUserId = ws._userId ?? null;
                const pubsubLagMs = pubsubReceiveMs != null ? (pubsubReceiveMs - refMs) : null;
                emitSlowDeliveryTrace({
                  messageId: typeof msgId === 'string' ? msgId : null,
                  channelId: typeof channelId === 'string' ? channelId : null,
                  conversationId: typeof conversationId === 'string' ? conversationId : null,
                  senderUserId: typeof senderUserId === 'string' ? senderUserId : null,
                  recipientUserId: typeof recipientUserId === 'string' ? recipientUserId : null,
                  eventType: typeof parsedData?.event === 'string' ? parsedData.event : null,
                  topicType: topicPrefix,
                  dest_vm: wl.vm,
                  dest_worker: wl.worker,
                  pubsub_receive_ms: pubsubReceiveMs,
                  pubsub_receive_lag_ms: pubsubLagMs != null && pubsubLagMs >= 0 ? pubsubLagMs : null,
                  socket_enqueue_ms: enqueueMs,
                  socket_enqueue_delay_ms: enqueueWaitMs,
                  socket_write_start_ms: sendStartMs,
                  socket_write_done_ms: sendDoneMs,
                  send_duration_ms: sendDurationMs,
                  delivery_done_ms: sendDoneMs,
                  total_delivery_ms: deltaMs,
                });
                if (deltaMs > 1000) {
                  wsDeliverySlowTraceTotal?.inc?.({ stage: 'total', reason: 'high_latency', vm: wl.vm, worker: wl.worker });
                }
                if (enqueueWaitMs != null && enqueueWaitMs > 500) {
                  wsDeliverySlowTraceTotal?.inc?.({ stage: 'socket_enqueue_wait', reason: 'slow_queue', vm: wl.vm, worker: wl.worker });
                }
                if (sendDurationMs > 500) {
                  wsDeliverySlowTraceTotal?.inc?.({ stage: 'socket_write', reason: 'slow_send', vm: wl.vm, worker: wl.worker });
                }
              }
            }
          }
        }
        ws._lastDataFrameAt = sendDoneMs;
        return;
      }
      ws._sawError = true;
      logger.warn(
        {
          err,
          event: "ws.send_failed",
          userId: ws._userId,
          redisChannel: logicalChannel,
          payloadEvent: payloadEventName,
          delivery_target_kind,
          delivery_path: delivery_path_kind,
          gradingNote: "correlate_with_failed_deliveries",
        },
        "WS send failed; terminating socket",
      );
      try {
        noteRecentDisconnectForSocket(ws, 1006, "send_failed");
        clearOutboundQueue(ws);
        ws.terminate();
      } catch {
        // Ignore termination failures after send errors.
      }
    });
  }

  function drainOutboundBatch(ws) {
    ensureOutboundQueue(ws);
    const q = ws._outboundQueue;
    const waiters = ws._outMsgWaiters;
    if (ws.readyState !== WebSocket.OPEN) {
      if (waiters.length) {
        waiters.length = 0;
      }
      if (q.length) {
        adjustWsOutboundGauge(-q.length);
        q.length = 0;
      }
      return 0;
    }
    const msgCap =
      Number.isFinite(WS_OUTBOUND_QUEUE_MAX_MESSAGE) && WS_OUTBOUND_QUEUE_MAX_MESSAGE > 0
        ? Math.floor(WS_OUTBOUND_QUEUE_MAX_MESSAGE)
        : 512;
    const batchCap =
      Number.isFinite(WS_OUTBOUND_DRAIN_BATCH) && WS_OUTBOUND_DRAIN_BATCH > 0
        ? Math.min(256, Math.floor(WS_OUTBOUND_DRAIN_BATCH))
        : 32;
    const promoteBudget = Math.max(batchCap * 4, 64);
    let promoted = 0;
    let n = 0;
    while (n < batchCap && ws.readyState === WebSocket.OPEN) {
      while (waiters.length > 0 && q.length < msgCap && promoted < promoteBudget) {
        q.push(waiters.shift());
        adjustWsOutboundGauge(1);
        promoted += 1;
      }
      if (!q.length) break;
      const job = q.shift();
      adjustWsOutboundGauge(-1);
      flushOutboundJob(ws, job);
      n += 1;
    }
    return n;
  }

  function scheduleOutboundDrain(ws) {
    ensureOutboundQueue(ws);
    if (ws._outboundDrainScheduled) return;
    const q = ws._outboundQueue;
    const waiters = ws._outMsgWaiters;
    const hasWork = q.length > 0 || waiters.length > 0;
    if (!hasWork) return;
    ws._outboundDrainScheduled = true;
    setImmediate(() => {
      ws._outboundDrainScheduled = false;
      if (ws.readyState !== WebSocket.OPEN) {
        clearOutboundQueue(ws);
        return;
      }
      const sent = drainOutboundBatch(ws);
      if (sent > 0) {
        wsOutboundDrainBatchesTotal.inc();
      }
      if (ws._outboundQueue.length > 0 || ws._outMsgWaiters.length > 0) {
        scheduleOutboundDrain(ws);
      }
    });
  }

  function sendPayloadToSocket(
    ws,
    logicalChannel,
    parsed,
    rawMessage,
    {
      bypassLogicalDuplicateSuppression = false,
      preparedPayload = null,
      deliveryPath = "realtime",
      deliverySource = "live_pubsub",
      debugReasonCounts = null,
      pubsubReceiveMs = null,
    } = {},
  ) {
    const bumpReason = (reason) => {
      if (!debugReasonCounts) return;
      debugReasonCounts[reason] = (debugReasonCounts[reason] || 0) + 1;
    };

    if (ws.readyState !== WebSocket.OPEN) {
      bumpReason("not_open");
      return false;
    }
    if (!bypassLogicalDuplicateSuppression && shouldSkipSocketForLogicalChannel(ws, logicalChannel, parsed)) {
      bumpReason("logical_suppressed");
      return false;
    }

    const prepared =
      preparedPayload || prepareSocketPayload(logicalChannel, parsed, rawMessage);
    const { dedupeKey, skipDropForBackpressure } = prepared;

    if (wasSocketMessageRecentlyDelivered(ws, dedupeKey)) {
      bumpReason("dedupe_recent_delivery");
      wsRecipientDedupeTotal?.inc?.({ path: wsDeliveryTopicPrefixForMetrics(logicalChannel) });
      return false;
    }

    const maxDepth = skipDropForBackpressure
      ? (Number.isFinite(WS_OUTBOUND_QUEUE_MAX_MESSAGE) && WS_OUTBOUND_QUEUE_MAX_MESSAGE > 0
        ? Math.floor(WS_OUTBOUND_QUEUE_MAX_MESSAGE)
        : 512)
      : (Number.isFinite(WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT) && WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT > 0
        ? Math.floor(WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT)
        : 128);

    ensureOutboundQueue(ws);
    const q = ws._outboundQueue;

    if (skipDropForBackpressure) {
      if (q.length >= maxDepth) {
        const waiters = ws._outMsgWaiters;
        if (waiters.length >= WS_OUTBOUND_MESSAGE_WAITERS_MAX) {
          wsBackpressureEventsTotal.inc({ action: "kill" });
          logger.warn(
            {
              event: "ws.outbound_waiters_overflow",
              userId: ws._userId,
              waiters: waiters.length,
              queue: q.length,
              delivery_target_kind: wsDeliveryTopicPrefixForMetrics(logicalChannel),
              delivery_path: deliveryPath,
              gradingNote: "correlate_with_failed_deliveries",
            },
            "WS outbound: message waiter backlog exceeded hard cap; terminating socket",
          );
          noteRecentDisconnectForSocket(ws, 1006, "outbound_waiters_overflow");
          clearOutboundQueue(ws);
          ws.terminate();
          bumpReason("waiters_overflow_terminated");
          return false;
        }
        waiters.push({
          logicalChannel,
          parsed,
          rawMessage,
          bypassLogicalDuplicateSuppression,
          preparedPayload: preparedPayload || prepared,
          deliveryPath,
          deliverySource,
          enqueueMs: Date.now(),
          pubsubReceiveMs,
        });
        wsOutboundQueueBlockWaitsTotal.inc();
        scheduleOutboundDrain(ws);
        return true;
      }
    } else if (q.length >= maxDepth) {
      wsOutboundQueueDroppedBestEffortTotal.inc();
      bumpReason("best_effort_queue_drop");
      return false;
    }

    const enqueueMs = Date.now();
    q.push({
      logicalChannel,
      parsed,
      rawMessage,
      bypassLogicalDuplicateSuppression,
      preparedPayload: preparedPayload || prepared,
      deliveryPath,
      deliverySource,
      enqueueMs,
      pubsubReceiveMs,
    });
    adjustWsOutboundGauge(1);
    const priority = skipDropForBackpressure ? "message" : "best_effort";
    wsOutboundQueueDepthHistogram.observe({ priority }, q.length);
    const wl = getWorkerLabels();
    wsSocketQueueDepthHistogram?.observe?.({ vm: wl.vm, worker: wl.worker }, q.length);
    scheduleOutboundDrain(ws);
    return true;
  }

  return {
    ensureOutboundQueue,
    clearOutboundQueue,
    sendPayloadToSocket,
  };
}

module.exports = {
  createOutboundQueueHelpers,
};
