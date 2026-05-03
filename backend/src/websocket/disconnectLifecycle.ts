function classifyDisconnectReason({
  closeCode = 1005,
  closeReason = "",
  clean = false,
  sawError = false,
  shuttingDown = false,
}) {
  const normalizedReason = String(closeReason || "").trim().toLowerCase();

  if (normalizedReason === "heartbeat_timeout") {
    return "heartbeat_timeout";
  }
  if (closeCode === 4001 || normalizedReason === "unauthorized" || normalizedReason === "token_revoked") {
    return "auth_revoke";
  }
  if (
    shuttingDown
    || normalizedReason === "service_restart"
    || normalizedReason === "keepalive_send_failed"
    || normalizedReason === "backpressure_kill"
    || normalizedReason === "send_failed"
    || normalizedReason === "outbound_waiters_overflow"
    || normalizedReason === "user_subscribe_failed"
    || normalizedReason === "subscription failed"
  ) {
    return "upstream_terminate";
  }
  if (clean || closeCode === 1000 || closeCode === 1001) {
    return "client_close";
  }
  if (closeCode === 1006 && !normalizedReason && !sawError) {
    return "network_abnormal";
  }
  if (closeCode === 1011 || sawError) {
    return "upstream_terminate";
  }
  return "network_abnormal";
}

function createDisconnectLifecycle({
  WebSocket,
  clearOutboundQueue,
  wsDisconnectsTotal,
  wsDisconnectReasonTotal,
  wsConnectionLifetimeMs,
  unsubscribeClient,
  unsubscribeCommunityClient,
  noteRecentDisconnectForSocket,
  isRedisOperational,
  redis,
  removeConnection,
  recomputeUserPresence,
  scheduleDebouncedPresenceRecompute,
  logWsHotInfo,
  logger,
  isShuttingDown,
}) {
  function cleanup(ws, userId, closeCode = 1005, closeReason = "") {
    clearOutboundQueue(ws);
    if (ws._bootstrapRecentConnectChannelIds) {
      delete ws._bootstrapRecentConnectChannelIds;
    }
    const subscriptions = [...ws._subscriptions];
    const bootstrapReady = ws._bootstrapReady === true;
    const lifetimeMs = Math.max(0, Date.now() - Number(ws._connectedAt || Date.now()));
    const clean = closeCode !== 1006;
    const subscriptionCount = subscriptions.length;
    const closeCodeLabel = String(closeCode || 1005);
    const effectiveCloseReason = closeReason || ws._disconnectReasonHint || "";
    const disconnectReason = classifyDisconnectReason({
      closeCode,
      closeReason: effectiveCloseReason,
      clean,
      sawError: ws._sawError === true,
      shuttingDown: isShuttingDown(),
    });

    wsDisconnectsTotal.inc({
      code: closeCodeLabel,
      clean: clean ? "true" : "false",
      bootstrap_ready: bootstrapReady ? "true" : "false",
    });
    wsDisconnectReasonTotal.inc({ reason: disconnectReason });
    wsConnectionLifetimeMs.observe(
      {
        close_code: closeCodeLabel,
        bootstrap_ready: bootstrapReady ? "true" : "false",
      },
      lifetimeMs,
    );

    Promise.allSettled(
      subscriptions.map((ch) => unsubscribeClient(ws, ch)),
    ).catch(() => {});
    for (const communityId of Array.from(ws._communityIds || [])) {
      unsubscribeCommunityClient(ws, communityId);
    }

    noteRecentDisconnectForSocket(ws, closeCode, effectiveCloseReason);

    const logPayload = {
      event: "ws.disconnected",
      userId,
      connectionId: ws._connectionId,
      closeCode,
      closeReason: effectiveCloseReason || null,
      disconnectReason,
      clean,
      bootstrapReady,
      lifetimeMs,
      sawError: ws._sawError === true,
      subscriptionCount,
    };

    const abnormalClose =
      !clean
      || ws._sawError === true
      || closeCode === 1011
      || closeCode === 4001;

    if (isShuttingDown()) {
      logWsHotInfo(() => ({ ...logPayload, shuttingDown: true }), "WS disconnected");
      return;
    }

    if (!isRedisOperational(redis)) {
      logWsHotInfo(() => ({ ...logPayload, redisOperational: false }), "WS disconnected");
      return;
    }

    removeConnection(userId, ws._connectionId)
      .then(() => {
        if (abnormalClose && disconnectReason !== "heartbeat_timeout") {
          return recomputeUserPresence(userId);
        }
        // Clean disconnect and heartbeat_timeout both use the debounced path.
        // Heartbeat kills are often followed by an immediate reconnect (mobile tab
        // backgrounded, brief network hiccup) — debouncing avoids offline→online churn.
        scheduleDebouncedPresenceRecompute(userId);
      })
      .catch((err) => {
        if (/Connection is closed/i.test(String(err?.message || err))) {
          logWsHotInfo(() => logPayload, "WS disconnected");
          return;
        }
        logger.warn({ err, userId }, "WS cleanup presence update failed");
      });
    if (abnormalClose) {
      logger.warn(logPayload, "WS disconnected abnormally");
    } else {
      logWsHotInfo(() => logPayload, "WS disconnected");
    }
  }

  return {
    cleanup,
  };
}

module.exports = {
  createDisconnectLifecycle,
  classifyDisconnectReason,
};
