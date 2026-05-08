function createRuntimeIntervals({
  wss,
  WebSocket,
  wsHeartbeatIntervalMs,
  wsAppKeepaliveIntervalMs = 0,
  wsHeartbeatMissedPingsBeforeKill = 2,
  presenceSweeperMs,
  noteRecentDisconnectForSocket,
  maybeSendAppKeepaliveFrame,
  reconcileAllConnectedUsers,
  logger,
}) {
  const missThreshold = Math.max(1, Math.floor(wsHeartbeatMissedPingsBeforeKill));

  const HEARTBEAT_BATCH_SIZE = 50;
  const KEEPALIVE_BATCH_SIZE = 50;
  function snapshotClients() {
    if (wss.clients && typeof wss.clients[Symbol.iterator] === "function") {
      return [...wss.clients];
    }

    const clients = [];
    if (wss.clients && typeof wss.clients.forEach === "function") {
      wss.clients.forEach((ws) => clients.push(ws));
    }
    return clients;
  }

  const heartbeatInterval = setInterval(() => {
    const clients = snapshotClients();
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
      }
      if (i < clients.length) setImmediate(processBatch);
    }
    processBatch();
  }, wsHeartbeatIntervalMs);

  const keepaliveInterval =
    wsAppKeepaliveIntervalMs > 0
      ? setInterval(() => {
          const clients = snapshotClients();
          let i = 0;
          function processBatch() {
            const end = Math.min(i + KEEPALIVE_BATCH_SIZE, clients.length);
            for (; i < end; i++) {
              const ws = clients[i];
              maybeSendAppKeepaliveFrame(ws);
            }
            if (i < clients.length) setImmediate(processBatch);
          }
          processBatch();
        }, wsAppKeepaliveIntervalMs)
      : null;

  const presenceSweepInterval = setInterval(() => {
    reconcileAllConnectedUsers().catch((err) => {
      logger.warn({ err }, "Presence sweeper failed");
    });
  }, presenceSweeperMs);

  function stopHeartbeat() {
    clearInterval(heartbeatInterval);
  }

  function stopKeepalive() {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
  }

  function stopPresenceSweep() {
    clearInterval(presenceSweepInterval);
  }

  function stopAll() {
    clearInterval(heartbeatInterval);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    clearInterval(presenceSweepInterval);
  }

  return {
    stopHeartbeat,
    stopKeepalive,
    stopPresenceSweep,
    stopAll,
  };
}

module.exports = {
  createRuntimeIntervals,
};
