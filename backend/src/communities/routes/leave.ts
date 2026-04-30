/**
 * Communities routes — leave
 */
const {
  param,
  query,
  queryRead,
  getClient,
  redis,
  logger,
  presenceService,
  fanout,
  publishUserFeedTargets,
  invalidateWsBootstrapCache,
  invalidateWsAclCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
  getCommunityChannelIds,
  warmChannelAccessCacheForUser,
  evictChannelAccessCacheForUser,
  recordEndpointListCache,
  recordEndpointListCacheBypass,
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
  getChannelLastMessageMetaMapFromRedis,
  incrCommunityMemberCount,
  decrCommunityMemberCount,
  getCommunityMemberCountsFromRedis,
} = require('./_deps');
const C = require('../communityShared');

module.exports = function register(router) {
router.delete("/:id/leave", param("id").isUUID(), async (req, res, next) => {
  if (!C.validate(req, res)) return;
  try {
    const { rowCount } = await query(
      `DELETE FROM community_members
       WHERE community_id=$1 AND user_id=$2 AND role != 'owner'
       RETURNING user_id`,
      [req.params.id, req.user.id],
    );
    if (!rowCount) {
      return res.json({ success: true });
    }

    decrCommunityMemberCount(req.params.id).catch(() => {});

    const { rows: remainingMembers } = await query(
      "SELECT user_id FROM community_members WHERE community_id=$1",
      [req.params.id],
    );

    await presenceService.invalidatePresenceFanoutTargets(req.user.id);
    invalidateWsBootstrapCache(req.user.id).catch(() => {});
    invalidateWsAclCache(req.user.id, `community:${req.params.id}`);

    const publicVersion = await C.getPublicCommunitiesVersion();

    const leaveChannelIds = await getCommunityChannelIds(req.params.id);
    evictChannelAccessCacheForUser(redis, leaveChannelIds, req.user.id).catch(
      () => {},
    );

    await Promise.allSettled([
      invalidateCommunityChannelUserFanoutTargetsCache(
        req.params.id,
        leaveChannelIds,
      ),
      C.invalidateCommunitiesCaches(
        [req.user.id, ...remainingMembers.map((member) => member.user_id)],
        publicVersion,
      ),
      redis.del(C.membersCacheKey(req.params.id)),
      fanout.publish(`community:${req.params.id}`, {
        event: "community:member_left",
        data: {
          userId: req.user.id,
          leftUserId: req.user.id,
          communityId: req.params.id,
        },
      }),
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Members + presence ─────────────────────────────────────────────────────────
};
