/**
 * Channel message:created fanout — publish to `channel:<id>` (primary path for scale),
 * then optionally duplicate to each visible member's `user:<id>` (grading / legacy).
 */

'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const fanout = require('../websocket/fanout');
const sideEffects = require('./sideEffects');
const {
  fanoutRecipientsHistogram,
  fanoutTargetCacheTotal,
  fanoutPublishDurationMs,
  fanoutPublishTargetsHistogram,
} = require('../utils/metrics');

const rawUserFanoutTargetsCacheTtl = Number(process.env.CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS || '180');
const CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS =
  Number.isFinite(rawUserFanoutTargetsCacheTtl) && rawUserFanoutTargetsCacheTtl > 0
    ? Math.floor(rawUserFanoutTargetsCacheTtl)
    : 180;
const channelUserFanoutTargetsInflight: Map<string, Promise<string[]>> = new Map();

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

function channelUserFanoutTargetsCacheKey(channelId: string) {
  return `channel:${channelId}:user_fanout_targets`;
}

async function invalidateChannelUserFanoutTargetsCache(channelId: string) {
  await redis.del(channelUserFanoutTargetsCacheKey(channelId));
}

async function invalidateCommunityChannelUserFanoutTargetsCache(communityId: string) {
  const { rows } = await query(
    `SELECT id::text AS id
     FROM channels
     WHERE community_id = $1`,
    [communityId],
  );

  const keys = rows.map((row: { id: string }) => channelUserFanoutTargetsCacheKey(row.id));
  if (!keys.length) return;
  await redis.del(...keys);
}

/**
 * Distinct user Redis keys (`user:<uuid>`) who may see this channel (public:
 * all community members; private: channel_members only).
 */
async function getChannelUserFanoutTargetKeys(channelId: string): Promise<string[]> {
  const cacheKey = channelUserFanoutTargetsCacheKey(channelId);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'hit' });
        return parsed.filter((value) => typeof value === 'string');
      }
    } catch {
      // Ignore parse failures and repopulate from Postgres below.
    }
    redis.del(cacheKey).catch(() => {});
  }

  if (channelUserFanoutTargetsInflight.has(cacheKey)) {
    fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'coalesced' });
    return channelUserFanoutTargetsInflight.get(cacheKey);
  }

  fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'miss' });
  const load = (async () => {
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
    const uniqueKeys = [...new Set(keys)];
    redis
      .set(cacheKey, JSON.stringify(uniqueKeys), 'EX', CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS)
      .catch(() => {});
    return uniqueKeys;
  })().finally(() => {
    channelUserFanoutTargetsInflight.delete(cacheKey);
  });

  channelUserFanoutTargetsInflight.set(cacheKey, load);
  return load;
}

async function publishUserTopicsOnly(channelId: string, envelope: Record<string, unknown>) {
  if (!channelMessageUserFanoutEnabled()) return;
  const startedAt = process.hrtime.bigint();
  const lookupStartedAt = startedAt;
  const targets = await getChannelUserFanoutTargetKeys(channelId);
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'target_lookup' },
    Number(process.hrtime.bigint() - lookupStartedAt) / 1e6,
  );
  const cap = fanoutMaxRecipients();
  const capped = targets.slice(0, Math.min(cap, targets.length));
  fanoutPublishTargetsHistogram.observe({ path: 'channel_message_user_topics' }, capped.length);
  fanoutRecipientsHistogram.observe({ channel_type: 'user' }, capped.length);

  const publishStartedAt = process.hrtime.bigint();
  const batchSize = 100;
  for (let i = 0; i < capped.length; i += batchSize) {
    const batch = capped.slice(i, i + batchSize);
    await Promise.all(batch.map((target) => fanout.publish(target, envelope)));
  }
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'publish' },
    Number(process.hrtime.bigint() - publishStartedAt) / 1e6,
  );
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );
}

/**
 * Publishes message:created for a channel. Order: optional `channel:<id>` first,
 * then user topics (blocking or via side-effect queue).
 */
async function publishChannelMessageCreated(channelId: string, envelope: Record<string, unknown>) {
  const chKey = `channel:${channelId}`;
  const firstChannel = channelPublishFirst();
  const startedAt = process.hrtime.bigint();

  if (firstChannel) {
    const channelPublishStartedAt = process.hrtime.bigint();
    await fanout.publish(chKey, envelope);
    fanoutPublishDurationMs.observe(
      { path: 'channel_message', stage: 'channel_topic' },
      Number(process.hrtime.bigint() - channelPublishStartedAt) / 1e6,
    );
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
    const channelPublishStartedAt = process.hrtime.bigint();
    await fanout.publish(chKey, envelope);
    fanoutPublishDurationMs.observe(
      { path: 'channel_message', stage: 'channel_topic' },
      Number(process.hrtime.bigint() - channelPublishStartedAt) / 1e6,
    );
  }

  fanoutPublishDurationMs.observe(
    { path: 'channel_message', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );
}

module.exports = {
  publishChannelMessageCreated,
  getChannelUserFanoutTargetKeys,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
};
