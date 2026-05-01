function createPresenceCoordinator({
  redis,
  presenceService,
  logger,
  connectionSetKey,
  connectionStatusHashKey,
  connectionActivityKey,
  connectionAliveKey,
  connectedUsersKey,
  presenceSweeperDebounceMs,
  presenceDisconnectDebounceMs,
}) {
  // Tracks the last time recomputeUserPresence ran for each user so the
  // reconcile sweeper can skip recently-computed slots.
  const lastPresenceComputedAt = new Map();
  // For clean disconnects, debounce post-disconnect presence recompute so
  // brief reconnects do not cause unnecessary offline->online churn.
  const pendingPresenceRecompute = new Map();

  function cancelPendingPresenceRecompute(userId: string) {
    const t = pendingPresenceRecompute.get(userId);
    if (t !== undefined) {
      clearTimeout(t);
      pendingPresenceRecompute.delete(userId);
    }
  }

  async function upsertConnectionState(userId, connectionId, status) {
    await redis
      .multi()
      .sadd(connectionSetKey(userId), connectionId)
      .sadd(connectedUsersKey(), userId)
      .hset(connectionStatusHashKey(userId), connectionId, status)
      .exec();
  }

  function resolveAggregateStatus(states) {
    let hasAway = false;
    let hasOnline = false;

    for (const state of states) {
      if (state === "away") hasAway = true;
      else if (state === "online") hasOnline = true;
    }

    if (hasAway) return "away";
    if (hasOnline) return "online";
    return "idle";
  }

  async function removeConnection(userId, connectionId) {
    await redis
      .multi()
      .srem(connectionSetKey(userId), connectionId)
      .hdel(connectionStatusHashKey(userId), connectionId)
      .del(connectionActivityKey(userId, connectionId))
      .del(connectionAliveKey(userId, connectionId))
      .exec();
  }

  async function getConnectionCount(userId) {
    return redis.scard(connectionSetKey(userId));
  }

  async function recomputeUserPresence(userId) {
    lastPresenceComputedAt.set(userId, Date.now());
    const connIds = await redis.smembers(connectionSetKey(userId));
    if (!connIds.length) {
      await redis.srem(connectedUsersKey(), userId);
      await presenceService.setPresence(userId, "offline");
      lastPresenceComputedAt.delete(userId);
      return;
    }

    const statusHash = connectionStatusHashKey(userId);
    const pipeline = redis.pipeline();
    for (const connId of connIds) {
      pipeline.hget(statusHash, connId);
      pipeline.exists(connectionActivityKey(userId, connId));
      pipeline.exists(connectionAliveKey(userId, connId));
    }
    const results = await pipeline.exec();

    const stateByConn = [];
    const staleConnIds = [];
    for (let i = 0; i < connIds.length; i += 1) {
      const statusRes = results[i * 3];
      const activityRes = results[i * 3 + 1];
      const aliveRes = results[i * 3 + 2];
      const connId = connIds[i];

      const status = statusRes?.[1] || "online";
      const isActive = Number(activityRes?.[1] || 0) === 1;
      const isAlive = Number(aliveRes?.[1] || 0) === 1;

      if (!isAlive) {
        staleConnIds.push(connId);
        continue;
      }

      if (status === "away") {
        stateByConn.push("away");
      } else if (status === "idle") {
        stateByConn.push("idle");
      } else {
        if (!isActive) {
          logger.debug({
            event: "presence.activity_expired",
            userId,
            connectionId: connId,
          });
        }
        stateByConn.push(isActive ? "online" : "idle");
      }
    }

    if (staleConnIds.length) {
      const stalePipe = redis.pipeline();
      for (const connId of staleConnIds) {
        stalePipe.srem(connectionSetKey(userId), connId);
        stalePipe.hdel(statusHash, connId);
        stalePipe.del(connectionActivityKey(userId, connId));
        stalePipe.del(connectionAliveKey(userId, connId));
      }
      await stalePipe.exec();
    }

    if (!stateByConn.length) {
      await redis.srem(connectedUsersKey(), userId);
      await presenceService.setPresence(userId, "offline");
      lastPresenceComputedAt.delete(userId);
      return;
    }

    const aggregateStatus = resolveAggregateStatus(stateByConn);
    if (aggregateStatus === "away") {
      await presenceService.setPresence(userId, "away", undefined);
      return;
    }
    await presenceService.setPresence(userId, aggregateStatus, null);
  }

  async function reconcileAllConnectedUsers() {
    const userIds = await redis.smembers(connectedUsersKey());
    const now = Date.now();
    const stale = userIds.filter((userId) => {
      const last = lastPresenceComputedAt.get(userId) || 0;
      return now - last >= presenceSweeperDebounceMs;
    });

    // Process in parallel with bounded concurrency so the sweeper does not
    // monopolize the event loop when many users are connected.
    const CONCURRENCY = 10;
    for (let i = 0; i < stale.length; i += CONCURRENCY) {
      await Promise.allSettled(
        stale.slice(i, i + CONCURRENCY).map((userId) => recomputeUserPresence(userId)),
      );
    }
  }

  function scheduleDebouncedPresenceRecompute(userId: string) {
    cancelPendingPresenceRecompute(userId);
    const t = setTimeout(() => {
      pendingPresenceRecompute.delete(userId);
      recomputeUserPresence(userId).catch(() => {});
    }, presenceDisconnectDebounceMs);
    t.unref();
    pendingPresenceRecompute.set(userId, t);
  }

  return {
    cancelPendingPresenceRecompute,
    scheduleDebouncedPresenceRecompute,
    upsertConnectionState,
    removeConnection,
    getConnectionCount,
    recomputeUserPresence,
    reconcileAllConnectedUsers,
  };
}

module.exports = {
  createPresenceCoordinator,
};
