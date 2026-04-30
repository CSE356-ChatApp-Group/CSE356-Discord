function createPresenceActivityHelpers({
  redis,
  connectionAliveKey,
  connectionActivityKey,
  CONNECTION_ALIVE_TTL_SECONDS,
  IDLE_TTL_SECONDS,
}) {
  async function markConnectionAlive(userId, connectionId) {
    await redis.set(
      connectionAliveKey(userId, connectionId),
      "1",
      "EX",
      CONNECTION_ALIVE_TTL_SECONDS,
    );
  }

  async function markConnectionActive(userId, connectionId) {
    await redis.set(
      connectionActivityKey(userId, connectionId),
      "1",
      "EX",
      IDLE_TTL_SECONDS,
    );
  }

  async function refreshConnectionTtls(userId, connectionId, { active = false } = {}) {
    const pipeline = redis.pipeline();
    pipeline.set(
      connectionAliveKey(userId, connectionId),
      "1",
      "EX",
      CONNECTION_ALIVE_TTL_SECONDS,
    );
    if (active) {
      pipeline.set(
        connectionActivityKey(userId, connectionId),
        "1",
        "EX",
        IDLE_TTL_SECONDS,
      );
    }
    await pipeline.exec();
  }

  function shouldRefreshOnlinePresence(ws) {
    if (ws._presenceStatus !== "online") return true;
    const lastActivityAt = Number(ws._lastActivityAt || 0);
    return !lastActivityAt || Date.now() - lastActivityAt >= IDLE_TTL_SECONDS * 1000;
  }

  return {
    markConnectionAlive,
    markConnectionActive,
    refreshConnectionTtls,
    shouldRefreshOnlinePresence,
  };
}

module.exports = {
  createPresenceActivityHelpers,
};
