/**
 * Communities routes — delete
 */
const {
  body,
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
router.delete(
  "/:id",
  param("id").isUUID(),
  C.loadMembership,
  async (req, res, next) => {
    if (!C.validate(req, res)) return;
    try {
      const {
        rows: [community],
      } = await query(
        "SELECT id, owner_id, is_public FROM communities WHERE id=$1",
        [req.params.id],
      );
      if (!community)
        return res.status(404).json({ error: "Community not found" });
      if (
        community.owner_id !== req.user.id ||
        req.membership?.role !== "owner"
      ) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { rows: memberRows } = await query(
        "SELECT user_id FROM community_members WHERE community_id=$1",
        [req.params.id],
      );
      await C.cleanupCommunityUnreadCounterKeys(req.params.id);

      // FK cascade from messages.channel_id -> channels.id was dropped (migration 023).
      // Delete all channel messages in this community before the community (and its
      // channels via channels.community_id CASCADE) are removed.
      await query(
        "DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE community_id = $1)",
        [req.params.id],
      );
      await query("DELETE FROM communities WHERE id=$1", [req.params.id]);

      if (community.is_public) {
        await C.bumpPublicCommunitiesVersion();
      }

      const publicVersion = await C.getPublicCommunitiesVersion();

      await Promise.allSettled([
        C.invalidateCommunitiesCaches(
          memberRows.map((r) => r.user_id),
          publicVersion,
        ),
        redis.del(C.membersCacheKey(req.params.id)),
        fanout.publish(`community:${req.params.id}`, {
          event: "community:deleted",
          data: { communityId: req.params.id },
        }),
      ]);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

// ── Join ───────────────────────────────────────────────────────────────────────
};
