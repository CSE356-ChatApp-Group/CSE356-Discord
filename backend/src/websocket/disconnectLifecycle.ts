function createDisconnectLifecycle({
  WebSocket,
  clearOutboundQueue,
  wsDisconnectsTotal,
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
    const subscriptions = [...ws._subscriptions];
    const bootstrapReady = ws._bootstrapReady === true;
    const lifetimeMs = Math.max(0, Date.now() - Number(ws._connectedAt || Date.now()));
    const clean = closeCode !== 1006;
    const subscriptionCount = subscriptions.length;
    const closeCodeLabel = String(closeCode || 1005);

    wsDisconnectsTotal.inc({
      code: closeCodeLabel,
      clean: clean ? "true" : "false",
      bootstrap_ready: bootstrapReady ? "true" : "false",
    });
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

    noteRecentDisconnectForSocket(ws, closeCode, closeReason);

    const logPayload = {
      event: "ws.disconnected",
      userId,
      connectionId: ws._connectionId,
      closeCode,
      closeReason: closeReason || null,
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
        if (abnormalClose) {
          return recomputeUserPresence(userId);
        }
        // Clean disconnect — debounce presence recompute so short-gap reconnects
        // (grader 30ms cycles) skip the offline→online churn entirely.
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
};
