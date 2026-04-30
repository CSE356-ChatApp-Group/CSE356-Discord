/**
 * Reconnect replay: DB-missed and Redis-pending message:created delivery to one socket.
 */


const { WebSocket } = require("ws");

async function replayMissedMessagesToSocket(
  deps,
  ws,
  userId,
  previousDisconnect,
  reconnectObservedAtMs,
) {
  const {
    loadReplayableMessagesForUser,
    logWsHotInfo,
    sendPayloadToSocket,
    WS_REPLAY_OUTBOUND_YIELD_EVERY,
  } = deps;
  const disconnectedAt = Number(previousDisconnect?.disconnectedAt || 0);
  const reconnectObservedAt = Number(reconnectObservedAtMs || 0);
  if (!Number.isFinite(disconnectedAt) || disconnectedAt <= 0) return;
  if (!Number.isFinite(reconnectObservedAt) || reconnectObservedAt <= disconnectedAt) return;
  if (ws.readyState !== WebSocket.OPEN) return;

  const closeCode =
    typeof previousDisconnect?.closeCode === "number"
      ? previousDisconnect.closeCode
      : undefined;

  const messages = await loadReplayableMessagesForUser(
    userId,
    disconnectedAt,
    reconnectObservedAt,
    closeCode,
  );
  if (!messages.length) return;
  const userChannel = `user:${userId}`;
  const publishedAt = new Date().toISOString();

  logWsHotInfo(
    () => ({
      event: "ws.replay.missed_messages",
      userId,
      connectionId: ws._connectionId,
      disconnectedAt,
      reconnectObservedAt,
      replayedMessages: messages.length,
      source: "db",
    }),
    "Replaying missed websocket messages after reconnect gap",
  );

  let replayed = 0;
  for (const message of messages) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      event: "message:created",
      data: message,
      publishedAt,
    };
    sendPayloadToSocket(
      ws,
      userChannel,
      payload,
      null,
      {
        bypassLogicalDuplicateSuppression: true,
        deliveryPath: "replay",
        deliverySource: "missed_db",
      },
    );
    replayed += 1;
    if (replayed % WS_REPLAY_OUTBOUND_YIELD_EVERY === 0 && replayed < messages.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

async function replayPendingMessagesToSocket(deps, ws, userId) {
  const { drainPendingMessagesForUser, sendPayloadToSocket, WS_REPLAY_OUTBOUND_YIELD_EVERY } =
    deps;
  const pendingPayloads = await drainPendingMessagesForUser(userId);
  if (!pendingPayloads.length) return 0;
  let n = 0;
  for (const payload of pendingPayloads) {
    if (ws.readyState !== WebSocket.OPEN) return 0;
    sendPayloadToSocket(
      ws,
      `user:${userId}`,
      payload,
      null,
      {
        bypassLogicalDuplicateSuppression: true,
        deliveryPath: "replay",
        deliverySource: "pending_queue",
      },
    );
    n += 1;
    if (n % WS_REPLAY_OUTBOUND_YIELD_EVERY === 0 && n < pendingPayloads.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return pendingPayloads.length;
}

module.exports = {
  replayMissedMessagesToSocket,
  replayPendingMessagesToSocket,
};
