const { validationResult } = require('express-validator');
const { query, queryRead } = require('../db/pool');
const redis            = require('../db/redis');
const logger           = require('../utils/logger');
const fanout           = require('../websocket/fanout');
const { publishUserFeedTargets } = require('../websocket/userFeed');
const {
  invalidateWsAclCache,
  invalidateWsBootstrapCaches,
  evictUnauthorizedChannelSubscribers,
} = require('../websocket/server');
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require('../utils/distributedSingleflight');
const { raceChannelAccess } = require('../messages/channelAccessCache');
const { getChannelLastMessageMetaMapFromRedis } = require('../messages/repointLastMessage');

const CHANNEL_RETURNING_FIELDS = `
  id,
  community_id,
  name,
  description,
  is_private,
  type,
  position,
  created_by,
  created_at,
  updated_at,
  last_message_id,
  last_message_author_id,
  last_message_at`;

const CHANNEL_SELECT_FIELDS = `
  ch.id,
  ch.community_id,
  ch.name,
  ch.description,
  ch.is_private,
  ch.type,
  ch.position,
  ch.created_by,
  ch.created_at,
  ch.updated_at,
  ch.last_message_id,
  ch.last_message_author_id,
  ch.last_message_at`;

const VISIBLE_CHANNEL_FIELDS = `
  vc.id,
  vc.community_id,
  vc.name,
  vc.description,
  vc.is_private,
  vc.type,
  vc.position,
  vc.created_by,
  vc.created_at,
  vc.updated_at`;

function v(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return false; }
  return true;
}

async function loadChannelContext(channelId, userId) {
  const { rows } = await query(
    `SELECT ch.id,
            ch.community_id,
            ch.is_private,
            cm.role AS community_role,
            EXISTS (
              SELECT 1
              FROM channel_members chm
              WHERE chm.channel_id = ch.id AND chm.user_id = $2
            ) AS is_channel_member
     FROM channels ch
     LEFT JOIN community_members cm
       ON cm.community_id = ch.community_id
      AND cm.user_id = $2
     WHERE ch.id = $1`,
    [channelId, userId]
  );
  return rows[0] || null;
}

async function checkChannelAccessForUser(channelId: string, userId: string): Promise<boolean> {
  try {
    const { rows } = await queryRead(
      `SELECT EXISTS (
         SELECT 1 FROM channels c
         JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = $2
         WHERE c.id = $1
           AND (c.is_private = FALSE
                OR EXISTS (SELECT 1 FROM channel_members WHERE channel_id = c.id AND user_id = $2))
       ) AS has_access`,
      [channelId, userId],
    );
    return rows[0]?.has_access === true;
  } catch {
    return false;
  }
}

function canManagePrivateMembership(role) {
  return ['owner', 'admin'].includes(role);
}

function canManageChannels(role) {
  return ['owner', 'admin'].includes(role);
}

function isBtreeTupleTooLargeError(err) {
  return err?.code === '54000' && err?.routine === 'index_form_tuple_context';
}

async function hasExactChannelNameConflict(communityId, name, excludeChannelId = null) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!communityId || !normalizedName) return false;
  const params = [communityId, normalizedName];
  let sql = `SELECT 1
             FROM channels
             WHERE community_id = $1
               AND name = $2`;
  if (excludeChannelId) {
    params.push(excludeChannelId);
    sql += ` AND id <> $3`;
  }
  sql += ' LIMIT 1';
  const { rows } = await query(sql, params);
  return rows.length > 0;
}

function applyChannelLastMessageMetadata(
  channels,
  latestByChannel,
) {
  if (!Array.isArray(channels) || !channels.length || !latestByChannel?.size) return;
  for (const ch of channels) {
    const latest = latestByChannel.get(ch.id);
    if (!latest) continue;
    ch.last_message_id = latest.msg_id;
    ch.last_message_author_id = latest.author_id || null;
    ch.last_message_at = latest.at || null;
  }
}

async function listCommunityUserIds(communityId, client = { query }) {
  const { rows } = await client.query(
    'SELECT user_id::text AS user_id FROM community_members WHERE community_id = $1',
    [communityId]
  );
  return rows.map((row) => row.user_id);
}

async function ensurePrivateChannelManagers(channelId, communityId, client) {
  const { rows } = await client.query(
    `SELECT user_id::text AS user_id
     FROM community_members
     WHERE community_id = $1
       AND role IN ('owner', 'admin')`,
    [communityId]
  );

  if (!rows.length) return;

  await client.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT $1, manager.user_id::uuid
     FROM unnest($2::text[]) AS manager(user_id)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [channelId, rows.map((row) => row.user_id)]
  );
}

async function listChannelLifecycleAudience(communityId, channelId, client = { query }) {
  const { rows } = await client.query(
    `SELECT cm.user_id::text AS user_id,
            (c.is_private = FALSE
             OR EXISTS (
               SELECT 1
               FROM channel_members chm
               WHERE chm.channel_id = c.id
                 AND chm.user_id = cm.user_id
             )) AS can_access
     FROM community_members cm
     JOIN channels c
       ON c.community_id = cm.community_id
      AND c.id = $2
     WHERE cm.community_id = $1`,
    [communityId, channelId]
  );
  return rows;
}

async function publishChannelLifecycleEvent(communityId, event, data) {
  await fanout.publish(`community:${communityId}`, { event, data });

  if (event === 'channel:deleted') {
    const userIds = await listCommunityUserIds(communityId);
    if (userIds.length > 0) {
      await publishUserFeedTargets(userIds, { event, data });
    }
    return;
  }

  const audience = await listChannelLifecycleAudience(communityId, data.id);
  const accessibleUserIds = [];
  const inaccessibleUserIds = [];

  for (const entry of audience) {
    if (entry.can_access) accessibleUserIds.push(entry.user_id);
    else inaccessibleUserIds.push(entry.user_id);
  }

  const publishTasks = [];
  if (accessibleUserIds.length > 0) {
    publishTasks.push(
      publishUserFeedTargets(accessibleUserIds, {
        event,
        data: {
          ...data,
          can_access: true,
          canAccess: true,
        },
      }),
    );
  }
  if (inaccessibleUserIds.length > 0) {
    publishTasks.push(
      publishUserFeedTargets(inaccessibleUserIds, {
        event,
        data: {
          ...data,
          can_access: false,
          canAccess: false,
        },
      }),
    );
  }
  if (publishTasks.length > 0) {
    await Promise.all(publishTasks);
  }
}

/**
 * Bust channels:list cache for every member of a community.
 * Fire-and-forget — runs after the response has been sent.
 */
async function bustChannelListCache(communityId) {
  try {
    const { rows } = await queryRead(
      'SELECT user_id::text FROM community_members WHERE community_id = $1',
      [communityId]
    );
    if (!rows.length) return;
    const keys = rows.flatMap((r) => {
      const key = `channels:list:${communityId}:${r.user_id}`;
      return [key, staleCacheKey(key)];
    });
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err }, 'channels:list cache bust failed');
  }
}

async function bustChannelListCacheForUser(communityId, userId) {
  try {
    const key = `channels:list:${communityId}:${userId}`;
    await redis.del(key, staleCacheKey(key));
  } catch (err) {
    logger.warn({ err, communityId, userId }, 'channels:list per-user cache bust failed');
  }
}

/** Same idea as communities/messages list: load tests pin many VUs to one reader user. */
const _channelsListTtl = parseInt(process.env.CHANNELS_LIST_CACHE_TTL_SECS || '60', 10);
const CHANNELS_LIST_CACHE_TTL_SECS =
  Number.isFinite(_channelsListTtl) && _channelsListTtl > 0 ? _channelsListTtl : 60;
const _channelMsgCountTtl = parseInt(process.env.CHANNEL_MSG_COUNT_REDIS_TTL_SECS || '2592000', 10);
const CHANNEL_MSG_COUNT_REDIS_TTL_SECS =
  Number.isFinite(_channelMsgCountTtl) && _channelMsgCountTtl > 0 ? _channelMsgCountTtl : 2_592_000;
const channelsListInflight = new Map();
module.exports = {
  CHANNEL_RETURNING_FIELDS,
  CHANNEL_SELECT_FIELDS,
  VISIBLE_CHANNEL_FIELDS,
  v,
  loadChannelContext,
  checkChannelAccessForUser,
  canManagePrivateMembership,
  canManageChannels,
  isBtreeTupleTooLargeError,
  hasExactChannelNameConflict,
  applyChannelLastMessageMetadata,
  listCommunityUserIds,
  ensurePrivateChannelManagers,
  listChannelLifecycleAudience,
  publishChannelLifecycleEvent,
  bustChannelListCache,
  bustChannelListCacheForUser,
  CHANNELS_LIST_CACHE_TTL_SECS,
  CHANNEL_MSG_COUNT_REDIS_TTL_SECS,
  channelsListInflight,
};
