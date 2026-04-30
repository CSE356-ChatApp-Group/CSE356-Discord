/**
 * Communities routes — members
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
router.get("/:id/members", param("id").isUUID(), async (req, res, next) => {
  if (!C.validate(req, res)) return;
  try {
    const { rows: accessRows } = await query(
      `SELECT cm.role AS my_role
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $2
       WHERE c.id = $1`,
      [req.params.id, req.user.id],
    );
    if (!accessRows.length)
      return res.status(404).json({ error: "Community not found" });
    if (!accessRows[0].my_role) {
      return res.status(403).json({ error: "Not a community member" });
    }

    const rows = await C.loadCommunityMembersRoster(req.params.id);
    const presenceMap = await presenceService.getBulkPresenceDetails(
      rows.map((r) => r.id),
    );
    const members = rows.map((r) => ({
      ...r,
      status: presenceMap[r.id]?.status || "offline",
      away_message: presenceMap[r.id]?.awayMessage || null,
    }));
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:id/members/:userId",
  param("id").isUUID(),
  param("userId").isUUID(),
  body("role").isIn(["member", "admin"]),
  C.loadMembership,
  async (req, res, next) => {
    if (!C.validate(req, res)) return;
    let client;
    try {
      if (req.membership?.role !== "owner") {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      client = await getClient();
      await client.query("BEGIN");

      const {
        rows: [community],
      } = await client.query(
        "SELECT id, owner_id FROM communities WHERE id = $1",
        [req.params.id],
      );
      if (!community) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Community not found" });
      }
      if (community.owner_id === req.params.userId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Cannot change owner role" });
      }

      const { rows } = await client.query(
        `UPDATE community_members
         SET role = $1
         WHERE community_id = $2 AND user_id = $3
         RETURNING community_id, user_id, role`,
        [req.body.role, req.params.id, req.params.userId],
      );
      if (!rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Member not found" });
      }

      await client.query("COMMIT");

      const publicVersion = await C.getPublicCommunitiesVersion();

      await Promise.allSettled([
        C.invalidateCommunitiesCaches([req.params.userId], publicVersion),
        redis.del(C.membersCacheKey(req.params.id)),
        fanout.publish(`community:${req.params.id}`, {
          event: "community:role_updated",
          data: {
            communityId: req.params.id,
            userId: req.params.userId,
            role: rows[0].role,
          },
        }),
      ]);

      res.json({
        member: {
          community_id: rows[0].community_id,
          user_id: rows[0].user_id,
          role: rows[0].role,
        },
      });
    } catch (err) {
      await client?.query("ROLLBACK");
      next(err);
    } finally {
      client?.release();
    }
  },
);

};
