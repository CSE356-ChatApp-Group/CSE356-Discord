/**
 * Channel message:created fanout — publish to every visible member's
 * `user:<id>` Redis topic so delivery does not depend on each socket already
 * being subscribed to `channel:<id>`.
 */

'use strict';

const { query } = require('../db/pool');
const fanout = require('../websocket/fanout');

/**
 * Distinct user Redis keys (`user:<uuid>`) who may see this channel (public:
 * all community members; private: channel_members only).
 */
async function getChannelUserFanoutTargetKeys(channelId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT DISTINCT cm.user_id::text AS user_id
     FROM channels c
     JOIN community_members cm ON cm.community_id = c.community_id
     WHERE c.id = $1
       AND (
         c.is_private = FALSE
         OR EXISTS (
           SELECT 1 FROM channel_members chm
           WHERE chm.channel_id = c.id AND chm.user_id = cm.user_id
         )
       )`,
    [channelId],
  );
  const keys: string[] = rows.map((r: { user_id: string }) => `user:${r.user_id}`);
  return [...new Set(keys)];
}

async function publishChannelMessageCreated(channelId: string, envelope: Record<string, unknown>) {
  const targets = await getChannelUserFanoutTargetKeys(channelId);
  const batchSize = 100;
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    await Promise.all(batch.map((target) => fanout.publish(target, envelope)));
  }
}

module.exports = {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
};
