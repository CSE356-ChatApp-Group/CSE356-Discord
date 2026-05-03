function createRecentDisconnectHelpers({
  redis,
  isRedisOperational,
  recentDisconnectKey,
  reconnectWindowLabel,
  WS_RECENT_DISCONNECT_TTL_SECONDS,
  wsReconnectsTotal,
  wsReconnectGapMs,
  logWsHotInfo,
}) {
  async function recordRecentDisconnect(userId, payload) {
    if (!isRedisOperational(redis)) return;
    await redis.set(
      recentDisconnectKey(userId),
      JSON.stringify(payload),
      "EX",
      WS_RECENT_DISCONNECT_TTL_SECONDS,
    );
  }

  function recentDisconnectPayloadForSocket(ws, closeCode = 1005, closeReason = "") {
    const subscriptions = ws?._subscriptions instanceof Set
      ? ws._subscriptions.size
      : Number(ws?._subscriptions?.size || 0) || 0;
    return {
      disconnectedAt: Date.now(),
      closeCode,
      closeReason: closeReason || ws?._disconnectReasonHint || null,
      bootstrapReady: ws?._bootstrapReady === true,
      lifetimeMs: Math.max(0, Date.now() - Number(ws?._connectedAt || Date.now())),
      sawError: ws?._sawError === true,
      subscriptionCount: subscriptions,
    };
  }

  function noteRecentDisconnectForSocket(ws, closeCode = 1005, closeReason = "") {
    const userId = typeof ws?._userId === "string" ? ws._userId : null;
    if (!userId) return;
    if (closeReason) {
      ws._disconnectReasonHint = closeReason;
    }
    if (ws._recentDisconnectRecorded === true) return;
    ws._recentDisconnectRecorded = true;
    recordRecentDisconnect(
      userId,
      recentDisconnectPayloadForSocket(ws, closeCode, closeReason),
    ).catch(() => {});
  }

  async function consumeRecentDisconnect(userId) {
    if (!isRedisOperational(redis)) return null;
    const key = recentDisconnectKey(userId);
    // Use GETDEL (Redis ≥ 6.2) to fetch-and-delete in one round trip.
    // Falls back to GET + DEL on older clients.
    let raw: string | null;
    if (typeof (redis as any).getdel === 'function') {
      raw = await (redis as any).getdel(key);
    } else {
      raw = await redis.get(key);
      if (raw) await redis.del(key).catch(() => {});
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function observeRecentReconnect(userId, connectionId, previous) {
    if (!previous) return;
    const disconnectedAt = Number(previous?.disconnectedAt || 0);
    if (!Number.isFinite(disconnectedAt) || disconnectedAt <= 0) return;

    const gapMs = Math.max(0, Date.now() - disconnectedAt);
    if (gapMs > WS_RECENT_DISCONNECT_TTL_SECONDS * 1000) return;

    wsReconnectsTotal.inc({ window: reconnectWindowLabel(gapMs) });
    wsReconnectGapMs.observe(gapMs);
    logWsHotInfo(() => ({
        event: "ws.reconnected_after_gap",
        userId,
        connectionId,
        gapMs,
        previousCloseCode: previous?.closeCode ?? null,
        previousBootstrapReady: previous?.bootstrapReady === true,
        previousLifetimeMs: Number(previous?.lifetimeMs || 0) || 0,
      }),
      "WS reconnect observed shortly after disconnect");
  }

  return {
    recordRecentDisconnect,
    recentDisconnectPayloadForSocket,
    noteRecentDisconnectForSocket,
    consumeRecentDisconnect,
    observeRecentReconnect,
  };
}

module.exports = {
  createRecentDisconnectHelpers,
};
