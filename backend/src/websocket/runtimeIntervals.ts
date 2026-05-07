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

  const HEARTBEAT_BATCH_SIZE = 50;

  const heartbeatInterval = setInterval(() => {
    const clients = [...wss.clients];
    let i = 0;
    function processBatch() {
      const end = Math.min(i + HEARTBEAT_BATCH_SIZE, clients.length);
      for (; i < end; i++) {
        const ws = clients[i];
        if (!ws.isAlive) {
          ws._missedPings = (ws._missedPings || 0) + 1;
          if (ws._missedPings >= missThreshold) {
            noteRecentDisconnectForSocket(ws, 1006, "heartbeat_timeout");
            ws.terminate();
            continue;
          }
        } else {
          ws._missedPings = 0;
        }
        ws.isAlive = false;
        ws.ping();
        maybeSendAppKeepaliveFrame(ws);
      }
      if (i < clients.length) setImmediate(processBatch);
    }
    setImmediate(processBatch);
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
