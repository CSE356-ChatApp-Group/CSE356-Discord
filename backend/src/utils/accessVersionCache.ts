'use strict';

function channelAccessVersionKey(channelId) {
  return `channel:${channelId}:user_fanout_targets_v`;
}

function conversationAccessVersionKey(conversationId) {
  return `conversation:${conversationId}:fanout_targets_v`;
}

function toAccessVersion(raw) {
  const parsed = Number(raw || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function scopeVersionKey(scope) {
  return scope.kind === 'channel'
    ? channelAccessVersionKey(scope.id)
    : conversationAccessVersionKey(scope.id);
}

function rowAccessScope(row) {
  if (row?.channel_id) return { kind: 'channel', id: String(row.channel_id) };
  if (row?.conversation_id) return { kind: 'conversation', id: String(row.conversation_id) };
  return null;
}

async function readAccessVersion(redis, versionKey) {
  try {
    return toAccessVersion(await redis.get(versionKey));
  } catch {
    return 0;
  }
}

module.exports = {
  channelAccessVersionKey,
  conversationAccessVersionKey,
  toAccessVersion,
  scopeVersionKey,
  rowAccessScope,
  readAccessVersion,
};
