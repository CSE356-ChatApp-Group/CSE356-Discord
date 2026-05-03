function createRuntimeIntervals({
  wss,
  WebSocket,
  wsHeartbeatIntervalMs,
  wsHeartbeatMissedPingsBeforeKill = 2,
  presenceSweeperMs,
  noteRecentDisconnectForSocket,
  maybeSendAppKeepaliveFrame,
  reconcileAllConnectedUsers,
  logger,
}) {
  const missThreshold = Math.max(1, Math.floor(wsHeartbeatMissedPingsBeforeKill));

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        // Increment consecutive-miss counter; only terminate after missThreshold.
        // This gives transient network blips and backgrounded tabs one extra interval
        // to recover before being killed.
        ws._missedPings = (ws._missedPings || 0) + 1;
        if (ws._missedPings >= missThreshold) {
          noteRecentDisconnectForSocket(ws, 1006, "heartbeat_timeout");
          ws.terminate();
          return; // skip ping on an already-terminated socket
        }
      } else {
        // Pong received since last tick — reset miss counter.
        ws._missedPings = 0;
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
