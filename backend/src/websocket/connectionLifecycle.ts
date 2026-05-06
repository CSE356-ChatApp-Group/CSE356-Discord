function createConnectionLifecycle({
  WebSocket,
  randomUUID,
  URL,
  authenticateAccessToken,
  verifyRefresh,
  isAuthBypassEnabled,
  getBypassAuthContext,
  wsConnectionResultTotal,
  logWsHotInfo,
  clientIpFromReq,
  markWsRecentConnect,
  subscribeClient,
  consumeRecentDisconnect,
  observeRecentReconnect,
  isWsReplayDisabled,
  wsReplayFailOpenTotal,
  tryBeginReplayForIp,
  waitForReplayGateOpen,
  getReplayInFlightCount,
  replayAdmissionConfig,
  endReplayForIp,
  tryAcquireReplaySlot,
  canRunReplayForUser,
  replayMissedMessagesToSocket,
  replayPendingMessagesToSocket,
  WS_REPLAY_USER_COOLDOWN_MS,
  releaseReplaySlot,
  noteRecentDisconnectForSocket,
  logger,
  handleClientMessage,
  refreshConnectionTtls,
  upsertConnectionState,
  cancelPendingPresenceRecompute,
  recomputeUserPresence,
  WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS,
  getBootstrapQueueDepth = null,
  bootstrapWithRetry,
  prepareBootstrapWithRetry,
  hydrateBootstrapWithMetrics,
  clearBootstrapPriming,
  wsReadyWallDurationMs,
  wsBootstrapProgressiveTotal,
  cleanup,
  replayStartupJitterMs,
}) {
  function wsBootstrapProgressiveReadyEnabled() {
    const raw = process.env.WS_BOOTSTRAP_PROGRESSIVE_READY;
    if (raw === undefined || raw === "") return false;
    const normalized = String(raw).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }

  function wsReplaySkipDbWhenPendingHit() {
    const raw = process.env.WS_REPLAY_SKIP_DB_WHEN_PENDING_HIT;
    if (raw === undefined || raw === "") return false;
    const normalized = String(raw).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  }

  function bearerTokenFromUpgradeHeaders(req) {
    const raw = req?.headers?.authorization;
    if (typeof raw !== "string") return null;
    if (raw.length < 8 || raw.slice(0, 7).toLowerCase() !== "bearer ") return null;
    const token = raw.slice(7).trim();
    return token || null;
  }

  function refreshTokenFromCookieHeader(headerValue) {
    if (typeof headerValue !== "string" || !headerValue) return null;
    const parts = headerValue.split(";");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.startsWith("refreshToken=")) continue;
      const encoded = trimmed.slice("refreshToken=".length).trim();
      if (!encoded) return null;
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
    return null;
  }

  async function runReconnectReplay(ws, user, recentDisconnect, replayUpperBoundMs) {
    if (!recentDisconnect) return;
    if (isWsReplayDisabled()) {
      wsReplayFailOpenTotal.inc({ reason: "disabled" });
      logWsHotInfo(() => ({ userId: user.id }), "WS reconnect replay skipped: DISABLE_WS_REPLAY");
      return;
    }
    if (ws._replayConsumed === true) {
      wsReplayFailOpenTotal.inc({ reason: "per_socket" });
      return;
    }
    if (!tryBeginReplayForIp(ws._clientIp)) {
      wsReplayFailOpenTotal.inc({ reason: "per_ip" });
      logger.warn(
        { userId: user.id, clientIp: ws._clientIp },
        "WS reconnect replay skipped: per-IP concurrent replay cap",
      );
      return;
    }

    const admission = await waitForReplayGateOpen(ws, user.id);
    if (!admission.ok) {
      if (!admission.cancelled) {
        wsReplayFailOpenTotal.inc({ reason: admission.gate.reason || "gate" });
      }
      logger.warn(
        {
          userId: user.id,
          reason: admission.gate.reason,
          waiting: admission.gate.pool.waiting,
          inFlight: getReplayInFlightCount(),
          maxInFlight: replayAdmissionConfig.replaySemaphoreMax,
          attempts: admission.attempts,
          deferredWaitMs: admission.totalWaitMs,
          cancelled: admission.cancelled,
        },
        "WS reconnect replay skipped after bounded admission waits",
      );
      endReplayForIp(ws._clientIp);
      return;
    }

    ws._replayConsumed = true;
    await new Promise((r) => setTimeout(r, replayStartupJitterMs()));
    if (ws.readyState !== WebSocket.OPEN) {
      endReplayForIp(ws._clientIp);
      return;
    }

    if (!tryAcquireReplaySlot()) {
      wsReplayFailOpenTotal.inc({ reason: "semaphore_full" });
      logger.warn(
        {
          userId: user.id,
          inFlight: getReplayInFlightCount(),
          maxInFlight: replayAdmissionConfig.replaySemaphoreMax,
        },
        "WS reconnect replay skipped: semaphore slot unavailable at execution",
      );
      endReplayForIp(ws._clientIp);
      return;
    }

    try {
      const replayStartedAt = Date.now();
      const replayAllowed = canRunReplayForUser(user.id);
      const preferPendingReplay = wsReplaySkipDbWhenPendingHit();
      let pendingReplayed = 0;
      if (preferPendingReplay) {
        pendingReplayed = await replayPendingMessagesToSocket(ws, user.id);
      }
      if (replayAllowed) {
        if (preferPendingReplay && pendingReplayed > 0) {
          logWsHotInfo(() => ({
              userId: user.id,
              connectionId: ws._connectionId,
              pendingReplayed,
            }),
            "WS reconnect DB replay skipped because Redis pending replay produced messages");
        } else {
          await replayMissedMessagesToSocket(
            ws,
            user.id,
            recentDisconnect,
            replayUpperBoundMs,
          );
        }
      } else {
        logWsHotInfo(() => ({
            userId: user.id,
            connectionId: ws._connectionId,
            cooldownMs: WS_REPLAY_USER_COOLDOWN_MS,
          }),
          "WS reconnect replay DB query skipped due to short per-user cooldown");
      }
      if (!preferPendingReplay) {
        pendingReplayed = await replayPendingMessagesToSocket(ws, user.id);
      }
      logWsHotInfo(() => ({
          event: "ws.replay.pending_drain",
          userId: user.id,
          connectionId: ws._connectionId,
          replayAndDrainMs: Date.now() - replayStartedAt,
          pendingReplayed,
        }),
        "WS reconnect replay + pending drain completed after ready");
    } catch (err) {
      logger.warn({ err, userId: user.id }, "WS reconnect replay failed");
    } finally {
      releaseReplaySlot();
      endReplayForIp(ws._clientIp);
    }
  }

  async function userFromRefreshCookie(req) {
    const refreshToken = refreshTokenFromCookieHeader(req?.headers?.cookie);
    if (!refreshToken) return null;
    const payload = verifyRefresh(refreshToken);
    const userId = String(payload?.id || "");
    if (!userId) return null;
    return { id: userId };
  }

  async function handleConnection(ws, req) {
    // Authenticate
    let user;
    let authFailureReason = "missing_credentials";
    try {
      const url = new URL(req.url, "ws://localhost");
      const queryToken = url.searchParams.get("token");
      const headerToken = bearerTokenFromUpgradeHeaders(req);
      if (queryToken) {
        user = await authenticateAccessToken(queryToken);
      } else if (headerToken) {
        user = await authenticateAccessToken(headerToken);
      } else {
        user = await userFromRefreshCookie(req);
      }
      if (!user) {
        if (!isAuthBypassEnabled()) throw new Error("No token");
        ({ user } = await getBypassAuthContext());
      }
    } catch (err) {
      if (err?.name === "TokenExpiredError") {
        authFailureReason = "token_expired";
      } else if (err?.name === "JsonWebTokenError") {
        authFailureReason = "token_invalid";
      } else if (err?.message === "No token") {
        authFailureReason = "missing_credentials";
      } else if (err?.message === "jwt must be provided") {
        authFailureReason = "missing_credentials";
      } else {
        authFailureReason = "auth_error";
      }
      wsConnectionResultTotal.inc({ result: "unauthorized" });
      wsConnectionResultTotal.inc({ result: `unauthorized_${authFailureReason}` });
      ws.close(4001, "Unauthorized");
      return;
    }

    wsConnectionResultTotal.inc({ result: "accepted" });
    logWsHotInfo(() => ({ userId: user.id }), "WS connected");
    ws._clientIp = clientIpFromReq(req);
    ws._replayConsumed = false;
    ws._subscriptions = new Set();
    ws._communityIds = new Set();
    /** `channel:<uuid>` topics the client explicitly { type: "unsubscribe" }'d — skip duplicate `user:<me>` message:* for those. */
    ws._explicitChannelUnsub = new Set();
    ws._userId = user.id;
    ws._connectionId = randomUUID();
    ws._connectedAt = Date.now();
    ws._lastDataFrameAt = ws._connectedAt;
    ws._bootstrapReady = false;
    ws._subscriptionsHydrated = false;
    ws._presenceStatus = "idle";
    ws._lastActivityAt = 0;
    ws._awayMessage = null;
    ws._sawError = false;
    ws._recentDisconnectRecorded = false;
    ws._missedPings = 0;
    ws._recentMessageKeys = new Map();
    ws._outboundQueue = [];
    ws._outboundDrainScheduled = false;

    // Mark freshly connected users for a short window so channel fanout can send
    // a targeted user-topic duplicate while channel auto-subscribe warms up.
    //
    // Ordering: markWsRecentConnect runs immediately; full channel/conversation
    // bootstrap (bootstrapWithRetry → bootstrapUserSubscriptions) runs in parallel
    // and can take seconds for large accounts. During that window the socket is
    // subscribed to user:<id> (below) but not yet to every channel:<id>. Live
    // channel message:created delivery therefore relies on the logical user:<id>
    // duplicate path — in particular CHANNEL_MESSAGE_USER_FANOUT_MODE=recent_connect
    // is not merely a throughput knob: with that mode, only users in the recent-connect
    // window receive the duplicate; turning it off or mis-tuning it can drop channel
    // messages for sockets still bootstrapping. Default mode=all avoids that coupling.
    markWsRecentConnect(user.id).catch(() => {});

    ws._bootstrapPromise = subscribeClient(ws, `user:${user.id}`)
      .then(async () => {
        // Capture the replay upper bound AFTER the user-topic subscribe completes.
        // This closes the race where messages arriving during subscribe latency (~5-20ms)
        // would be missed by both live delivery (subscribe not yet active) and replay
        // (created_at > upper bound). Capturing now covers the full subscribe gap,
        // at the cost of a few extra DB rows scanned — acceptable given replay limit=60.
        const replayUpperBoundMs = Date.now();
        // Consume the recent-disconnect key AFTER subscribe succeeds, not at
        // connect-start. If we consumed it eagerly and this connection died before
        // bootstrap completed (bootstrapReady:false, lifetimeMs<100ms), the key
        // would be deleted but replay would never fire — the next reconnect attempt
        // would then have no key and silently skip replay.
        const recentDisconnect = await consumeRecentDisconnect(user.id).catch(() => null);
        observeRecentReconnect(user.id, ws._connectionId, recentDisconnect);
        ws._bootstrapReady = true;
        if (recentDisconnect) {
          setImmediate(() => {
            void runReconnectReplay(ws, user, recentDisconnect, replayUpperBoundMs);
          });
        }
      })
      .catch((err) => {
        wsConnectionResultTotal.inc({ result: "user_subscribe_failed" });
        logger.warn({ err, userId: user.id }, "WS user-channel subscribe failed");
        noteRecentDisconnectForSocket(ws, 1011, "user_subscribe_failed");
        ws.close(1011, "Subscription failed");
      });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleClientMessage(ws, user, msg).catch((err) => {
          logger.warn({ err, userId: user.id }, "WS message dispatch failed");
        });
      } catch {
        ws.send(JSON.stringify({ event: "error", data: "Invalid JSON" }));
      }
    });

    ws.on("close", (code, reasonBuffer) => {
      const reason =
        typeof reasonBuffer?.toString === "function" ? reasonBuffer.toString() : "";
      cleanup(ws, user.id, code, reason);
    });

    ws.on("error", (err) => {
      ws._sawError = true;
      logger.warn({ err, userId: user.id }, "WS error");
    });

    // Heartbeat / pong
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
      refreshConnectionTtls(user.id, ws._connectionId).catch(() => {});
      markWsRecentConnect(user.id).catch(() => {});
    });

    ws._presenceInitPromise = upsertConnectionState(user.id, ws._connectionId, "idle")
      .then(async () => {
        // Cancel any debounced disconnect recompute — this connection supersedes it.
        cancelPendingPresenceRecompute(user.id);
        await refreshConnectionTtls(user.id, ws._connectionId, { active: false });
        await recomputeUserPresence(user.id);
      })
      .catch((err) =>
        logger.warn({ err, userId: user.id }, "WS presence setup failed"),
      );

    const progressiveReady = wsBootstrapProgressiveReadyEnabled();
    const bootstrapSubscriptionsPromise = (async () => {
      // Skip ingress jitter when no hydration work is queued — jitter only helps spread
      // burst load; when the scheduler queue is empty it adds pure latency.
      const queueDepth = getBootstrapQueueDepth?.() ?? 1;
      if (WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS > 0 && queueDepth > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.floor(Math.random() * (WS_BOOTSTRAP_INGRESS_JITTER_MAX_MS + 1))),
        );
      }
      if (progressiveReady) {
        return prepareBootstrapWithRetry(ws, user.id);
      }
      return bootstrapWithRetry(ws, user.id);
    })();
    bootstrapSubscriptionsPromise
      .catch((err) => {
        wsConnectionResultTotal.inc({ result: "bootstrap_failed" });
        logger.warn({ err, userId: user.id }, "WS auto-subscribe bootstrap failed");
      });

    const readyBarrierPromise = progressiveReady
      ? Promise.resolve(ws._bootstrapPromise).then(() => [])
      : Promise.all([ws._bootstrapPromise, bootstrapSubscriptionsPromise])
          .then(([, preparedChannels]) => preparedChannels);

    readyBarrierPromise
      .then((preparedChannels) => {
        if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) {
          return;
        }
        // Defensive guard: ensure the personal user feed channel is attached on
        // every connection before advertising subscriptionsHydrated=true.
        // This prevents a reconnect edge where user:<id> could be absent and DM
        // invite/participant events (published via userfeed shards) would miss.
        return subscribeClient(ws, `user:${user.id}`)
          .catch((err) => {
            logger.warn({ err, userId: user.id }, "WS ready guard: user-channel resubscribe failed");
          })
          .then(async () => {
            if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) return;
            await Promise.resolve(ws._presenceInitPromise).catch(() => {});
            ws._lastDataFrameAt = Date.now();
            const readyMode = progressiveReady ? "progressive" : "strict";
            const readyWallMs = ws._lastDataFrameAt - (ws._connectedAt || ws._lastDataFrameAt);
            wsReadyWallDurationMs?.observe?.({ mode: readyMode }, Math.max(0, readyWallMs));
            ws.send(
              JSON.stringify({
                event: "ready",
                data: {
                  bootstrapComplete: !progressiveReady,
                  subscriptionsHydrated: !progressiveReady,
                  progressiveHydration: progressiveReady,
                  connectedAt: ws._connectedAt,
                  readyAt: ws._lastDataFrameAt,
                },
              }),
            );
            if (!progressiveReady) {
              ws._subscriptionsHydrated = true;
              return;
            }
            wsBootstrapProgressiveTotal?.inc?.({ result: "ready_sent" });
            ws._progressiveHydrationPromise = Promise.resolve(bootstrapSubscriptionsPromise)
              .then((channels) => hydrateBootstrapWithMetrics(
                ws,
                user.id,
                Array.isArray(channels) ? channels : [],
              ))
              .then((result) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const hydrationSkipped = result?.status === "skipped";
                ws._subscriptionsHydrated = !hydrationSkipped;
                wsBootstrapProgressiveTotal?.inc?.({
                  result: hydrationSkipped ? "hydration_skipped" : "hydration_complete",
                });
                ws.send(
                  JSON.stringify({
                    event: "bootstrap:complete",
                    type: "bootstrap:complete",
                    data: {
                      bootstrapComplete: !hydrationSkipped,
                      subscriptionsHydrated: !hydrationSkipped,
                      progressiveHydration: true,
                      hydrationSkipped,
                      hydrationSkipReason: hydrationSkipped ? result.reason : undefined,
                      connectedAt: ws._connectedAt,
                      completedAt: Date.now(),
                    },
                  }),
                );
              })
              .catch((err) => {
                wsBootstrapProgressiveTotal?.inc?.({ result: "hydration_failed" });
                logger.warn({ err, userId: user.id }, "WS progressive bootstrap hydration failed");
              });
          });
      })
      .catch(() => {
        if (progressiveReady) {
          clearBootstrapPriming?.(ws);
        }
      });
  }

  return {
    handleConnection,
  };
}

module.exports = {
  createConnectionLifecycle,
};
