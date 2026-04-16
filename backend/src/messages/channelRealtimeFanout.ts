/**
 * Channel message:created fanout — publish to `channel:<id>` (primary path for scale),
 * then optionally duplicate to each visible member's `user:<id>` (grading / legacy).
 */

'use strict';

const { query } = require('../db/pool');
const redis = require('../db/redis');
const fanout = require('../websocket/fanout');
const { publishUserFeedTargets } = require('../websocket/userFeed');
const sideEffects = require('./sideEffects');
const { wsRecentConnectKey } = require('../websocket/recentConnect');
const logger = require('../utils/logger');
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

/**
 * `all` is the safe default because grader clients rely on server-managed
 * subscriptions and do not explicitly subscribe after connect. `recent_connect`
 * remains available as an opt-in throughput experiment for controlled hosts
 * that can tolerate channel-only delivery after the reconnect bridge expires.
 */
function userFanoutMode() {
  const v = String(process.env.CHANNEL_MESSAGE_USER_FANOUT_MODE || 'all')
    .trim()
    .toLowerCase();
  if (v === 'recent_connect') return 'recent_connect';
  return 'all';
}

function channelUserFanoutTargetsCacheKey(channelId: string) {
  return `channel:${channelId}:user_fanout_targets`;
}

function channelUserFanoutTargetsVersionKey(channelId: string) {
  return `channel:${channelId}:user_fanout_targets_v`;
}

async function invalidateChannelUserFanoutTargetsCache(channelId: string) {
  const cacheKey = channelUserFanoutTargetsCacheKey(channelId);
  const versionKey = channelUserFanoutTargetsVersionKey(channelId);
  try {
    const pipeline = redis.pipeline();
    pipeline.del(cacheKey);
    pipeline.incr(versionKey);
    await pipeline.exec();
  } catch {
    await redis.del(cacheKey).catch(() => {});
    await redis.incr(versionKey).catch(() => {});
  }
}

async function invalidateCommunityChannelUserFanoutTargetsCache(communityId: string) {
  const { rows } = await query(
    `SELECT id::text AS id
     FROM channels
     WHERE community_id = $1`,
    [communityId],
  );

  if (!rows.length) return;

  try {
    const pipeline = redis.pipeline();
    rows.forEach((row: { id: string }) => {
      pipeline.del(channelUserFanoutTargetsCacheKey(row.id));
      pipeline.incr(channelUserFanoutTargetsVersionKey(row.id));
    });
    await pipeline.exec();
  } catch {
    await Promise.allSettled(
      rows.map((row: { id: string }) => invalidateChannelUserFanoutTargetsCache(row.id)),
    );
  }
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
  const versionKey = channelUserFanoutTargetsVersionKey(channelId);
  const maxVersionRetries = 8;
  const load: Promise<string[]> = (async (): Promise<string[]> => {
    for (let attempt = 0; attempt < maxVersionRetries; attempt += 1) {
      const vBeforeQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
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
      const vAfterQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
      if (vBeforeQuery !== vAfterQuery) {
        continue;
      }

      const keys: string[] = rows.map((r: { user_id: string }) => `user:${r.user_id}`);
      const uniqueKeys = Array.from(new Set(keys));
      redis
        .set(cacheKey, JSON.stringify(uniqueKeys), 'EX', CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS)
        .catch(() => {});
      return uniqueKeys;
    }

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
    return Array.from(new Set(rows.map((r: { user_id: string }) => `user:${r.user_id}`)));
  })().finally(() => {
    channelUserFanoutTargetsInflight.delete(cacheKey);
  });

  channelUserFanoutTargetsInflight.set(cacheKey, load);
  return load;
}

async function publishUserTopicTargets(
  targets: string[],
  envelope: Record<string, unknown>,
  path: string,
) {
  if (!targets.length) return;
  const publishStartedAt = process.hrtime.bigint();
  fanoutPublishTargetsHistogram.observe({ path }, targets.length);
  fanoutRecipientsHistogram.observe({ channel_type: 'user' }, targets.length);
  await publishUserFeedTargets(targets, envelope);
  fanoutPublishDurationMs.observe(
    { path, stage: 'publish' },
    Number(process.hrtime.bigint() - publishStartedAt) / 1e6,
  );
}

async function recentConnectTargets(targets: string[]) {
  if (!targets.length) return [];
  try {
    const markers = await redis.mget(...targets.map((target) => wsRecentConnectKey(target.slice(5))));
    return targets.filter((_target, idx) => !!markers[idx]);
  } catch (err) {
    logger.warn(
      { err, targetCount: targets.length },
      'Recent-connect bridge lookup failed; falling back to full user fanout',
    );
    return targets;
  }
}

async function resolveUserTopicTargets(channelId: string) {
  if (!channelMessageUserFanoutEnabled()) {
    return { allTargets: [], recentTargets: [] };
  }

  const startedAt = process.hrtime.bigint();
  const lookupStartedAt = startedAt;
  const targets = await getChannelUserFanoutTargetKeys(channelId);
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'target_lookup' },
    Number(process.hrtime.bigint() - lookupStartedAt) / 1e6,
  );
  const cap = fanoutMaxRecipients();
  const capped = targets.slice(0, Math.min(cap, targets.length));

  if (!capped.length) {
    fanoutPublishDurationMs.observe(
      { path: 'channel_message_user_topics', stage: 'total' },
      Number(process.hrtime.bigint() - startedAt) / 1e6,
    );
    return { allTargets: [], recentTargets: [] };
  }

  if (userFanoutMode() === 'all') {
    fanoutPublishDurationMs.observe(
      { path: 'channel_message_user_topics', stage: 'total' },
      Number(process.hrtime.bigint() - startedAt) / 1e6,
    );
    return { allTargets: capped, recentTargets: [] };
  }

  const recentLookupStartedAt = process.hrtime.bigint();
  const inlineTargets = await recentConnectTargets(capped);
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_recent_connect_user_topics', stage: 'target_lookup' },
    Number(process.hrtime.bigint() - recentLookupStartedAt) / 1e6,
  );
  fanoutPublishDurationMs.observe(
    { path: 'channel_message_user_topics', stage: 'total' },
    Number(process.hrtime.bigint() - startedAt) / 1e6,
  );

  return { allTargets: inlineTargets, recentTargets: inlineTargets };
}

async function publishDeferredUserTopics(
  targets: string[],
  envelope: Record<string, unknown>,
) {
  await publishUserTopicTargets(targets, envelope, 'channel_message_user_topics');
}

/**
 * Publishes message:created for a channel. Order: optional `channel:<id>` first,
 * then user topics (blocking or via side-effect queue).
 */
async function publishChannelMessageCreated(channelId: string, envelope: Record<string, unknown>) {
  const chKey = `channel:${channelId}`;
  const firstChannel = channelPublishFirst();
  const startedAt = process.hrtime.bigint();
  const mode = userFanoutMode();
  const { allTargets, recentTargets: hintedRecentTargets } = await resolveUserTopicTargets(channelId);

  if (firstChannel) {
    const channelPublishStartedAt = process.hrtime.bigint();
    await fanout.publish(chKey, envelope);
    fanoutPublishDurationMs.observe(
      { path: 'channel_message', stage: 'channel_topic' },
      Number(process.hrtime.bigint() - channelPublishStartedAt) / 1e6,
    );
  }

  const blocking = userFanoutHttpBlocking();
  const recentTargets =
    mode === 'all' && !blocking
      ? await recentConnectTargets(allTargets)
      : hintedRecentTargets;
  const recentTargetSet = new Set(recentTargets);
  const inlineTargets =
    mode === 'all' && !blocking
      ? recentTargets
      : allTargets;
  const deferredTargets =
    mode === 'all' && !blocking
      ? allTargets.filter((target) => !recentTargetSet.has(target))
      : [];

  if (inlineTargets.length > 0) {
    await publishUserTopicTargets(
      inlineTargets,
      envelope,
      mode === 'all'
        ? 'channel_message_user_topics'
        : 'channel_message_recent_connect_user_topics',
    );
  }

  if (!blocking && deferredTargets.length > 0) {
    sideEffects.enqueueFanoutJob('fanout.channel_message.user_topics', () =>
      publishDeferredUserTopics(deferredTargets, envelope),
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
