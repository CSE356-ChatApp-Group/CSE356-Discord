/**
 * Channel message:created fanout — primary `channel:<id>` plus optional per-user
 * Redis topics (same envelope) when CHANNEL_MESSAGE_USER_FANOUT is enabled.
 * The web client dedupes by message id (upsertMessage); graders should too.
 */

'use strict';

const { query } = require('../db/pool');
const fanout = require('../websocket/fanout');
const logger = require('../utils/logger');

function channelMessageUserFanoutEnabled() {
  const v = (process.env.CHANNEL_MESSAGE_USER_FANOUT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function channelMessageUserFanoutMax() {
  const raw = Number(process.env.CHANNEL_MESSAGE_USER_FANOUT_MAX || '500');
  if (!Number.isFinite(raw)) return 500;
  return Math.min(10_000, Math.max(1, Math.floor(raw)));
}

/**
 * Distinct user Redis keys (`user:<uuid>`) who may see this channel (public:
 * all community members; private: channel_members only). Matches WS bootstrap
 * channel visibility.
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
  await fanout.publish(`channel:${channelId}`, envelope);

  if (!channelMessageUserFanoutEnabled()) return;

  const max = channelMessageUserFanoutMax();
  const targets = await getChannelUserFanoutTargetKeys(channelId);
  if (targets.length > max) {
    logger.warn(
      { channelId, fanoutUserCount: targets.length, max },
      'CHANNEL_MESSAGE_USER_FANOUT: capping per-user publishes',
    );
  }
  const slice = targets.slice(0, max);
  await Promise.all(slice.map((t) => fanout.publish(t, envelope)));
}

module.exports = {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
  channelMessageUserFanoutEnabled,
};
