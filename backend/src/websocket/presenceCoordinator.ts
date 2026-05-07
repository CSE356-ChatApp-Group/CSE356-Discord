function createPresenceCoordinator({
  redis,
  presenceService,
  logger,
  connectionSetKey,
  connectionStatusHashKey,
  connectionActivityKey,
  connectionAliveKey,
  connectionOwnerKey = null,
  workerOwnerHashKey = null,
  connectedUsersKey,
  presenceSweeperDebounceMs,
  presenceDisconnectDebounceMs,
  connectionAliveKeyTtlSeconds,
  currentWorkerOwnerId = null,
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

  function ownerId() {
    return typeof currentWorkerOwnerId === "function" ? currentWorkerOwnerId() : null;
  }

  async function decrementWorkerOwnerCount(userId, owner) {
    if (!workerOwnerHashKey || typeof owner !== "string" || !owner) return;
    const key = workerOwnerHashKey(userId);
    const next = await redis.hincrby(key, owner, -1);
    if (Number(next) <= 0) {
      await redis.hdel(key, owner);
    }
  }

  async function upsertConnectionState(userId, connectionId, status) {
    const workerOwner = ownerId();
    const multi = redis
      .multi()
      .sadd(connectionSetKey(userId), connectionId)
      .sadd(connectedUsersKey(), userId)
      .hset(connectionStatusHashKey(userId), connectionId, status);
    // Set the alive key atomically so the presence sweeper never sees a
    // newly-connected user without an alive key before refreshConnectionTtls
    // has a chance to run.
    if (connectionAliveKeyTtlSeconds) {
      multi.set(connectionAliveKey(userId, connectionId), '1', 'EX', connectionAliveKeyTtlSeconds);
    }
    let ownerSetResultIndex = -1;
    if (connectionOwnerKey && workerOwner && connectionAliveKeyTtlSeconds) {
      ownerSetResultIndex = 4;
      multi.set(
        connectionOwnerKey(userId, connectionId),
        workerOwner,
        'EX',
        connectionAliveKeyTtlSeconds,
        'NX',
      );
    }
    const results = await multi.exec();
    if (
      workerOwnerHashKey
      && workerOwner
      && ownerSetResultIndex >= 0
      && results?.[ownerSetResultIndex]?.[1] === 'OK'
    ) {
      await redis.hincrby(workerOwnerHashKey(userId), workerOwner, 1);
    }
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
    const owner = connectionOwnerKey
      ? await redis.get(connectionOwnerKey(userId, connectionId))
      : null;
    const multi = redis
      .multi()
      .srem(connectionSetKey(userId), connectionId)
      .hdel(connectionStatusHashKey(userId), connectionId)
      .del(connectionActivityKey(userId, connectionId))
      .del(connectionAliveKey(userId, connectionId));
    if (connectionOwnerKey) {
      multi.del(connectionOwnerKey(userId, connectionId));
    }
    await multi.exec();
    if (owner) {
      await decrementWorkerOwnerCount(userId, owner);
    }
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
      pipeline.get(connectionOwnerKey ? connectionOwnerKey(userId, connId) : `__noop__:${connId}`);
    }
    const results = await pipeline.exec();

    const stateByConn = [];
    const staleConnIds = [];
    const staleConnOwners = [];
    for (let i = 0; i < connIds.length; i += 1) {
      const statusRes = results[i * 4];
      const activityRes = results[i * 4 + 1];
      const aliveRes = results[i * 4 + 2];
      const ownerRes = results[i * 4 + 3];
      const connId = connIds[i];

      const status = statusRes?.[1] || "online";
      const isActive = Number(activityRes?.[1] || 0) === 1;
      const isAlive = Number(aliveRes?.[1] || 0) === 1;

      if (!isAlive) {
        staleConnIds.push(connId);
        staleConnOwners.push(typeof ownerRes?.[1] === 'string' ? ownerRes[1] : null);
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
      for (let i = 0; i < staleConnIds.length; i += 1) {
        const connId = staleConnIds[i];
        stalePipe.srem(connectionSetKey(userId), connId);
        stalePipe.hdel(statusHash, connId);
        stalePipe.del(connectionActivityKey(userId, connId));
        stalePipe.del(connectionAliveKey(userId, connId));
        if (connectionOwnerKey) {
          stalePipe.del(connectionOwnerKey(userId, connId));
        }
      }
      await stalePipe.exec();
      await Promise.all(
        staleConnOwners
          .filter((value) => typeof value === 'string' && value)
          .map((value) => decrementWorkerOwnerCount(userId, value)),
      );
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
    recomputeUserPresence,
    reconcileAllConnectedUsers,
  };
}

module.exports = {
  createPresenceCoordinator,
};
