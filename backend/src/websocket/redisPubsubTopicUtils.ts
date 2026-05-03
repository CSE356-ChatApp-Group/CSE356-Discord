/**
 * Small pure helpers for Redis pub/sub → WebSocket delivery (testable in isolation).
 */

const { parseChannelKey } = require('./channelKeyParse');

function normalizeCommunityTopic(value: unknown) {
  if (typeof value !== 'string') return null;
  const parsed = parseChannelKey(
    value.startsWith('community:') ? value : `community:${value}`,
  );
  if (!parsed || parsed.type !== 'community') return null;
  return parsed.id;
}

function isDuplicateSuppressionOnly(reasonCounts: Record<string, unknown> | null | undefined) {
  if (!reasonCounts || typeof reasonCounts !== 'object') return false;
  const entries = Object.entries(reasonCounts)
    .filter(([, count]) => Number(count) > 0);
  if (entries.length === 0) return false;
  return entries.every(([reason]) => reason === 'dedupe_recent_delivery' || reason === 'dedupe_skip');
}

module.exports = {
  normalizeCommunityTopic,
  isDuplicateSuppressionOnly,
};
