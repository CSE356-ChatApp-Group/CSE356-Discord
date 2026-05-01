const { parseChannelKey } = require('./channelKeyParse');

function createChannelAclHelpers({
  query,
  aclCache,
  aclCheckInFlight,
  aclCacheKey,
  readAclSharedCacheEntry,
  setAclDecision,
}) {
  async function isAllowedChannelDb(user, channel) {
    const parsed = parseChannelKey(channel);
    if (!parsed) return false;

    if (parsed.type === "user") {
      return parsed.id === user.id;
    }

    if (parsed.type === "community") {
      const { rows } = await query(
        `SELECT 1
         FROM community_members
         WHERE community_id = $1 AND user_id = $2`,
        [parsed.id, user.id],
      );
      return rows.length > 0;
    }

    if (parsed.type === "conversation") {
      const { rows } = await query(
        `SELECT 1
         FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [parsed.id, user.id],
      );
      return rows.length > 0;
    }

    const { rows } = await query(
      `SELECT 1
       FROM channels c
       JOIN community_members cm
         ON cm.community_id = c.community_id
        AND cm.user_id = $1
       WHERE c.id = $2
         AND (
           c.is_private = FALSE
           OR EXISTS (
             SELECT 1
             FROM channel_members chm
             WHERE chm.channel_id = c.id
               AND chm.user_id = $1
           )
         )`,
      [user.id, parsed.id],
    );
    return rows.length > 0;
  }

  async function isAllowedChannel(user, channel) {
    const cacheKey = aclCacheKey(user.id, channel);
    const cached = aclCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;

    const pending = aclCheckInFlight.get(cacheKey);
    if (pending) return pending;

    const done = (async () => {
      try {
        const sharedCached = await readAclSharedCacheEntry(user.id, channel);
        if (sharedCached !== null) {
          setAclDecision(user.id, channel, sharedCached, { writeShared: false });
          return sharedCached;
        }
        const allowed = await isAllowedChannelDb(user, channel);
        setAclDecision(user.id, channel, allowed);
        return allowed;
      } finally {
        aclCheckInFlight.delete(cacheKey);
      }
    })();

    aclCheckInFlight.set(cacheKey, done);
    return done;
  }

  return {
    parseChannelKey,
    isAllowedChannel,
  };
}

module.exports = {
  createChannelAclHelpers,
};
