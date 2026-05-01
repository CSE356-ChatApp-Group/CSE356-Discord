/**
 * Shared channel topic parsing for ACL, WS routing, and Redis pub/sub.
 */

function parseChannelKey(channel: string) {
  if (typeof channel !== 'string') return null;
  const match = channel.match(
    /^(channel|conversation|community|user):([\w-]+)$/,
  );
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

module.exports = { parseChannelKey };
