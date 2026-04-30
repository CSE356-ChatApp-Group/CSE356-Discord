/**
 * Communities routes — create
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
router.post(
  "/",
  body("slug")
    .isString()
    .custom((value) => value.trim().length > 0),
  body("name")
    .isString()
    .custom((value) => value.trim().length > 0),
  body("description").optional().isString(),
  body("isPublic").optional().isBoolean(),
  async (req, res, next) => {
    if (!C.validate(req, res)) return;
    let client;
    try {
      client = await getClient();
      await client.query("BEGIN");
      const slug = String(req.body.slug).trim();
      const name = String(req.body.name).trim();
      const description =
        typeof req.body.description === "string" ? req.body.description : null;
      const { isPublic = true } = req.body;
      const { rowCount } = await client.query(
        "SELECT 1 FROM communities WHERE owner_id = $1",
        [req.user.id],
      );
      if (rowCount >= 100) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Maximum 100 communities reached" });
      }
      const { rows } = await client.query(
        `INSERT INTO communities (slug, name, description, is_public, owner_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${C.COMMUNITY_RETURNING_FIELDS}`,
        [slug, name, description || null, isPublic, req.user.id],
      );
      const community = rows[0];

      await client.query(
        `INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'owner')`,
        [community.id, req.user.id],
      );
      community.member_count = 1;

      // Create a default #general channel and return its ID
      const { rows: channelRows } = await client.query(
        `INSERT INTO channels (community_id, name, created_by) VALUES ($1,'general',$2) RETURNING id`,
        [community.id, req.user.id],
      );
      const defaultChannelId = channelRows[0].id;

      await client.query("COMMIT");

      // Warm access cache for the owner on the newly created channel
      warmChannelAccessCacheForUser(
        redis,
        [defaultChannelId],
        req.user.id,
      ).catch(() => {});

      await Promise.allSettled([
        presenceService.invalidatePresenceFanoutTargets(req.user.id),
        invalidateWsBootstrapCache(req.user.id),
      ]);
      if (isPublic) {
        await C.bumpPublicCommunitiesVersion();
      }
      const publicVersion = await C.getPublicCommunitiesVersion();
      C.invalidateCommunitiesCaches([req.user.id], publicVersion).catch(() => {});
      // Redundant id fields: harness / generated clients sometimes read `body.id`
      // or `body.communityId` instead of `body.community.id`, producing `/communities//join`.
      res.status(201).json({
        community,
        id: community.id,
        communityId: community.id,
      });
    } catch (err) {
      await client?.query("ROLLBACK");
      if (err.code === "23505")
        return res.status(409).json({ error: "Slug already taken" });
      next(err);
    } finally {
      client?.release();
    }
  },
);

// ── Get ────────────────────────────────────────────────────────────────────────
};
