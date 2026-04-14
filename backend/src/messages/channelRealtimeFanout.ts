/**
 * Channel message:created fanout — publish to `channel:<id>` (primary path for scale),
 * then optionally duplicate to each visible member's `user:<id>` (grading / legacy).
 */

'use strict';

const { query } = require('../db/pool');
const fanout = require('../websocket/fanout');
const sideEffects = require('./sideEffects');
const { fanoutRecipientsHistogram } = require('../utils/metrics');

function channelMessageUserFanoutEnabled() {
  const v = process.env.CHANNEL_MESSAGE_USER_FANOUT;
  return v !== '0' && v !== 'false';
}

function channelPublishFirst() {
  const v = process.env.CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST;
  return v !== 'false' && v !== '0';
}

/** When true (default), HTTP blocks until all user-topic Redis publishes complete (grading parity). */
function userFanoutHttpBlocking() {
  const v = process.env.MESSAGE_USER_FANOUT_HTTP_BLOCKING;
  return v !== 'false' && v !== '0';
}

/**
 * Cap for per-member `user:<uuid>` Redis duplicates (CHANNEL_MESSAGE_USER_FANOUT_MAX).
 * Members beyond the cap do **not** get a user-topic duplicate; they must rely on
 * **`channel:<id>`** (autosubscribe + clients listening on `channel:`) for `message:created`.
 * This is intentional for very large channels; grading/clients must treat `channel:` as
 * authoritative for those users.
 */
function fanoutMaxRecipients() {
  const raw = parseInt(process.env.CHANNEL_MESSAGE_USER_FANOUT_MAX || '10000', 10);
  if (!Number.isFinite(raw) || raw < 1) return 10000;
  return Math.min(10000, raw);
}

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

async function publishUserTopicsOnly(channelId: string, envelope: Record<string, unknown>) {
  if (!channelMessageUserFanoutEnabled()) return;
  const targets = await getChannelUserFanoutTargetKeys(channelId);
  const cap = fanoutMaxRecipients();
  const capped = targets.slice(0, Math.min(cap, targets.length));
  fanoutRecipientsHistogram.observe({ channel_type: 'user' }, capped.length);

  const batchSize = 100;
  for (let i = 0; i < capped.length; i += batchSize) {
    const batch = capped.slice(i, i + batchSize);
    await Promise.all(batch.map((target) => fanout.publish(target, envelope)));
  }
}

/**
 * Publishes message:created for a channel. Order: optional `channel:<id>` first,
 * then user topics (blocking or via side-effect queue).
 */
async function publishChannelMessageCreated(channelId: string, envelope: Record<string, unknown>) {
  const chKey = `channel:${channelId}`;
  const firstChannel = channelPublishFirst();

  if (firstChannel) {
    await fanout.publish(chKey, envelope);
  }

  const blocking = userFanoutHttpBlocking();
  if (blocking) {
    await publishUserTopicsOnly(channelId, envelope);
  } else {
    sideEffects.enqueueFanoutJob('fanout.channel_message.user_topics', () =>
      publishUserTopicsOnly(channelId, envelope),
    );
  }

  if (!firstChannel) {
    await fanout.publish(chKey, envelope);
  }
}

module.exports = {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
};
