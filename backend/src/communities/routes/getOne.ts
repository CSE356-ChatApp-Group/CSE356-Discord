/**
 * Communities routes — getOne
 */
const { body, param } = require('express-validator');
const { query, queryRead, getClient } = require('../../db/pool');
const redis = require('../../db/redis');
const logger = require('../../utils/logger');
const presenceService = require('../../presence/service');
const fanout = require('../../websocket/fanout');
const { publishUserFeedTargets } = require('../../websocket/userFeed');
const {
  invalidateWsBootstrapCache,
  invalidateWsAclCache,
} = require('../../websocket/server');
const {
  invalidateCommunityChannelUserFanoutTargetsCache,
  getCommunityChannelIds,
} = require('../../messages/channelRealtimeFanout');
const {
  warmChannelAccessCacheForUser,
  evictChannelAccessCacheForUser,
} = require('../../messages/channelAccessCache');
const {
  recordEndpointListCache,
  recordEndpointListCacheBypass,
} = require('../../utils/endpointCacheMetrics');
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require('../../utils/distributedSingleflight');
const {
  getChannelLastMessageMetaMapFromRedis,
} = require('../../messages/repointLastMessage');
const {
  incrCommunityMemberCount,
  decrCommunityMemberCount,
  getCommunityMemberCountsFromRedis,
} = require('../communityMemberCount');
const C = require('../communityShared');

module.exports = function register(router) {
router.get("/:id", param("id").isUUID(), async (req, res, next) => {
  if (!C.validate(req, res)) return;
  try {
    const { rows } = await queryRead(
      `SELECT ${C.COMMUNITY_SELECT_FIELDS},
              json_agg(
                ${C.COMMUNITY_DETAIL_CHANNEL_JSON}
              ) FILTER (
                WHERE ch.id IS NOT NULL
                  AND (
                    ch.is_private = FALSE
                    OR EXISTS (
                      SELECT 1 FROM channel_members cm
                      WHERE cm.channel_id = ch.id AND cm.user_id = $2
                    )
                  )
              ) AS channels
       FROM communities c
       LEFT JOIN channels ch ON ch.community_id = c.id
       WHERE c.id = $1
         AND (c.is_public = TRUE OR EXISTS (
               SELECT 1 FROM community_members cm2
               WHERE cm2.community_id = c.id AND cm2.user_id = $2
             ))
       GROUP BY c.id`,
      [req.params.id, req.user.id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const community = rows[0];
    const redisCounts = await getCommunityMemberCountsFromRedis([community.id]);
    const redisCount = redisCounts.get(community.id);
    if (redisCount !== undefined) community.member_count = redisCount;
    if (Array.isArray(community.channels) && community.channels.length > 0) {
      const latestByChannel = await getChannelLastMessageMetaMapFromRedis(
        community.channels.map((ch) => ch.id),
        "community_channel",
      );
      C.applyCommunityChannelLastMessageMetadata(
        community.channels,
        latestByChannel,
      );
    }
    res.json({ community });
  } catch (err) {
    next(err);
  }
});

};
