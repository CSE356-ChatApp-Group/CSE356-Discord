/**
 * Communities routes — join
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
// Body-based join for harnesses that POST /communities/join with id in JSON (no :id path).
router.post(
  "/join",
  C.communityJoinIpRateLimiter,
  C.communityJoinUserRateLimiter,
  async (req, res, next) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const raw = String(
      body.communityId ??
        body.community_id ??
        body.id ??
        body.slug ??
        body.name ??
        "",
    ).trim();
    if (!raw) {
      return res
        .status(400)
        .json({ error: "Missing community id", requestId: req.id });
    }
    try {
      const resolved = await C.resolveCommunityIdForPublicJoin(raw);
      return C.executeResolvedPublicJoin(req, res, next, resolved);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/join",
  C.communityJoinIpRateLimiter,
  C.communityJoinUserRateLimiter,
  param("id").trim().isLength({ min: 1, max: 512 }),
  async (req, res, next) => {
    if (!C.validate(req, res)) return;
    try {
      const resolved = await C.resolveCommunityIdForPublicJoin(req.params.id);
      return C.executeResolvedPublicJoin(req, res, next, resolved);
    } catch (err) {
      next(err);
    }
  },
);

};
