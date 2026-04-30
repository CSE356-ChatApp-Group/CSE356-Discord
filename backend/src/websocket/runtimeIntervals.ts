function createRuntimeIntervals({
  wss,
  WebSocket,
  wsHeartbeatIntervalMs,
  presenceSweeperMs,
  noteRecentDisconnectForSocket,
  maybeSendAppKeepaliveFrame,
  reconcileAllConnectedUsers,
  logger,
}) {
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        noteRecentDisconnectForSocket(ws, 1006, "heartbeat_timeout");
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
      maybeSendAppKeepaliveFrame(ws);
    });
  }, wsHeartbeatIntervalMs);

  const presenceSweepInterval = setInterval(() => {
    reconcileAllConnectedUsers().catch((err) => {
      logger.warn({ err }, "Presence sweeper failed");
    });
  }, presenceSweeperMs);

  function stopHeartbeat() {
    clearInterval(heartbeatInterval);
  }

  function stopPresenceSweep() {
    clearInterval(presenceSweepInterval);
  }

  function stopAll() {
    clearInterval(heartbeatInterval);
    clearInterval(presenceSweepInterval);
  }

  return {
    stopHeartbeat,
    stopPresenceSweep,
    stopAll,
  };
}

module.exports = {
  createRuntimeIntervals,
};
