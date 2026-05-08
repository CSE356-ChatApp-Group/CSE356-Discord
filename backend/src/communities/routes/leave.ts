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
      // Either the user wasn't a member or they're the owner. In either
      // case the cached membership flag (if any) is now wrong relative to
      // the user's intent — drop it so the next /join request takes the
      // slow path and re-establishes truth.
      C.forgetUserCommunityMembership(req.user.id, req.params.id).catch(() => {});
      return res.json({ success: true });
    }

    // Invalidate the per-user membership cache before any awaits below so a
    // racing /join request from the same user re-runs the slow path.
    C.forgetUserCommunityMembership(req.user.id, req.params.id).catch(() => {});

    decrCommunityMemberCount(req.params.id).catch(() => {});

    const { rows: remainingMembers } = await query(
      "SELECT user_id FROM community_members WHERE community_id=$1",
      [req.params.id],
    );

    const affectedPresenceUserIds = [
      req.user.id,
      ...remainingMembers.map((member) => member.user_id),
    ];
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
      presenceService.invalidatePresenceFanoutTargetsBulk(affectedPresenceUserIds),
      C.invalidateCommunitiesCaches(
        [req.user.id, ...remainingMembers.map((member) => member.user_id)],
        publicVersion,
        'membership_change',
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
