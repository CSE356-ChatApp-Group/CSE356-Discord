function waitForSocketClose(WebSocket, ws, timeoutMs) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.off("close", finish);
      resolve(undefined);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    ws.once("close", finish);
  });
}

function createShutdownLifecycle({
  WebSocket,
  wss,
  clearHeartbeatInterval,
  clearPresenceSweepInterval,
  recordRecentDisconnect,
  recentDisconnectPayloadForSocket,
  removeConnection,
  recomputeUserPresence,
  shutdownCloseGraceMs,
  serviceRestartCloseCode,
  serviceRestartCloseReason,
  setShuttingDown,
}) {
  async function shutdown() {
    setShuttingDown(true);
    clearHeartbeatInterval();
    clearPresenceSweepInterval();

    const disconnectWrites = [];
    const cleanupWrites = [];
    const usersToRecompute = new Set();
    const closeWaits = [];

    wss.clients.forEach((ws) => {
      try {
        const userId = typeof ws?._userId === "string" ? ws._userId : null;
        const connectionId = typeof ws?._connectionId === "string" ? ws._connectionId : null;
        if (userId && !ws._recentDisconnectRecorded) {
          ws._recentDisconnectRecorded = true;
          disconnectWrites.push(
            recordRecentDisconnect(
              userId,
              recentDisconnectPayloadForSocket(
                ws,
                serviceRestartCloseCode,
                serviceRestartCloseReason,
              ),
            ).catch(() => {}),
          );
        }
        if (userId && connectionId) {
          usersToRecompute.add(userId);
          cleanupWrites.push(removeConnection(userId, connectionId).catch(() => {}));
        }

        if (ws.readyState === WebSocket.OPEN) {
          closeWaits.push(waitForSocketClose(WebSocket, ws, shutdownCloseGraceMs));
          ws.close(serviceRestartCloseCode, serviceRestartCloseReason);
        } else if (ws.readyState === WebSocket.CLOSING) {
          closeWaits.push(waitForSocketClose(WebSocket, ws, shutdownCloseGraceMs));
        } else if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      } catch {
        // Ignore socket errors during shutdown.
      }
    });

    await Promise.allSettled([...disconnectWrites, ...cleanupWrites]);
    await Promise.allSettled(
      Array.from(usersToRecompute).map((userId) => recomputeUserPresence(userId).catch(() => {})),
    );

    await Promise.allSettled(closeWaits);
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.terminate();
        } catch {
          // Ignore termination errors during shutdown.
        }
      }
    });

    await new Promise((resolve) => {
      wss.close(() => resolve(undefined));
    });
  }

  return {
    shutdown,
  };
}

module.exports = {
  createShutdownLifecycle,
};
