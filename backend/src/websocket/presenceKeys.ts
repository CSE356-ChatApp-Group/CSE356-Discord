function connectionSetKey(userId) {
  return `user:${userId}:connections`;
}

function connectionStatusHashKey(userId) {
  return `user:${userId}:connection_status`;
}

function connectionActivityKey(userId, connectionId) {
  return `user:${userId}:connection:${connectionId}:activity`;
}

function connectionAliveKey(userId, connectionId) {
  return `user:${userId}:connection:${connectionId}:alive`;
}

function connectedUsersKey() {
  return "presence:connected_users";
}

function recentDisconnectKey(userId) {
  return `ws:recent_disconnect:${userId}`;
}

function reconnectWindowLabel(gapMs) {
  if (gapMs <= 5_000) return "le_5s";
  if (gapMs <= 30_000) return "le_30s";
  return "le_120s";
}

module.exports = {
  connectionSetKey,
  connectionStatusHashKey,
  connectionActivityKey,
  connectionAliveKey,
  connectedUsersKey,
  recentDisconnectKey,
  reconnectWindowLabel,
};
