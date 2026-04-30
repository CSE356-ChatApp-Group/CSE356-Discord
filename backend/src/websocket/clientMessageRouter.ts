function createClientMessageRouter({
  WebSocket,
  logger,
  refreshConnectionTtls,
  isAllowedChannel,
  subscribeBootstrapChannel,
  parseChannelKey,
  unsubscribeCommunityClient,
  unsubscribeClient,
  shouldRefreshOnlinePresence,
  upsertConnectionState,
  recomputeUserPresence,
  presenceService,
}) {
  async function handleClientMessage(ws, user, msg) {
    if (ws._bootstrapPromise) {
      await ws._bootstrapPromise;
    }
    if (ws._presenceInitPromise) {
      await ws._presenceInitPromise;
    }
    if (ws.readyState !== WebSocket.OPEN || ws._bootstrapReady !== true) {
      return;
    }

    refreshConnectionTtls(user.id, ws._connectionId).catch(() => {});

    switch (msg.type) {
      case "subscribe": {
        let allowed;
        try {
          allowed = await isAllowedChannel(user, msg.channel);
        } catch (err) {
          logger.warn({ err, userId: user.id, channel: msg.channel }, "WS subscribe: channel access check failed");
          ws.send(JSON.stringify({ event: "error", data: "Subscribe temporarily unavailable" }));
          break;
        }
        if (allowed) {
          try {
            await subscribeBootstrapChannel(ws, msg.channel);
            ws.send(
              JSON.stringify({
                event: "subscribed",
                data: { channel: msg.channel },
              }),
            );
          } catch {
            ws.send(JSON.stringify({ event: "error", data: "Subscribe failed" }));
          }
        } else {
          ws.send(
            JSON.stringify({ event: "error", data: "Channel not allowed" }),
          );
        }
        break;
      }

      case "unsubscribe":
        if (typeof msg.channel === "string" && msg.channel.startsWith("community:")) {
          const parsed = parseChannelKey(msg.channel);
          if (parsed?.type === "community") unsubscribeCommunityClient(ws, parsed.id);
        } else {
          // Keep user:<self> sticky for this socket; it is the control plane for
          // DM invites/participant updates and bootstrap subscribe commands.
          if (msg.channel === `user:${user.id}`) {
            break;
          }
          await unsubscribeClient(ws, msg.channel);
        }
        break;

      case "ping":
        ws.send(JSON.stringify({ event: "pong" }));
        break;

      case "presence": {
        // Client reporting its own presence status
        if (["online", "idle", "away"].includes(msg.status)) {
          const nextStatus = msg.status;
          const awayMessageChanged =
            nextStatus === "away" && (msg.awayMessage || null) !== (ws._awayMessage || null);
          const redundantOnlineRefresh =
            nextStatus === "online" && !shouldRefreshOnlinePresence(ws);

          if (!awayMessageChanged && nextStatus === ws._presenceStatus && (nextStatus !== "online" || redundantOnlineRefresh)) {
            if (nextStatus === "online") {
              ws._lastActivityAt = Date.now();
              refreshConnectionTtls(user.id, ws._connectionId, { active: true }).catch(() => {});
            }
            break;
          }

          upsertConnectionState(user.id, ws._connectionId, nextStatus)
            .then(async () => {
              ws._presenceStatus = nextStatus;
              if (nextStatus === "away") {
                ws._awayMessage = msg.awayMessage || null;
                await presenceService.setAwayMessage(user.id, msg.awayMessage);
              } else {
                ws._awayMessage = null;
              }
              if (nextStatus === "online") {
                ws._lastActivityAt = Date.now();
                await refreshConnectionTtls(user.id, ws._connectionId, { active: true });
              }
              await recomputeUserPresence(user.id);
            })
            .catch(() => {});
        }
        break;
      }

      case "away_message": {
        const nextAwayMessage = msg.message || null;
        if (nextAwayMessage === (ws._awayMessage || null)) {
          break;
        }

        ws._awayMessage = nextAwayMessage;
        if (ws._presenceStatus === "away") {
          presenceService.setPresence(user.id, "away", nextAwayMessage).catch(() => {});
        } else {
          presenceService.setAwayMessage(user.id, nextAwayMessage).catch(() => {});
        }
        break;
      }

      case "activity": {
        const now = Date.now();
        const needsRefresh = shouldRefreshOnlinePresence(ws);
        refreshConnectionTtls(user.id, ws._connectionId, { active: true })
          .then(async () => {
            ws._lastActivityAt = now;
            if (!needsRefresh) return;
            ws._presenceStatus = "online";
            ws._awayMessage = null;
            await upsertConnectionState(user.id, ws._connectionId, "online");
            await recomputeUserPresence(user.id);
          })
          .catch(() => {});
        break;
      }

      default:
        ws.send(
          JSON.stringify({ event: "error", data: `Unknown type: ${msg.type}` }),
        );
    }
  }

  return {
    handleClientMessage,
  };
}

module.exports = {
  createClientMessageRouter,
};
