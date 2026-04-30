/**
 * Communities routes — list
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
router.get("/", async (req, res, next) => {
  const page = C.parseCommunitiesPageQuery(req);
  if (page.error) return res.status(400).json({ error: page.error });

  if (page.limit) {
    try {
      const publicVersion = await C.getPublicCommunitiesVersion();
      const userVersion = await C.getCommunitiesUserVersion(req.user.id);
      const cacheKey = C.communitiesPagedCacheKey(
        req.user.id,
        publicVersion,
        userVersion,
        page.limit,
        page.after || "",
      );
      const cached = await getJsonCache(redis, cacheKey);
      if (cached) {
        recordEndpointListCache("communities", "hit");
        return res.json(cached);
      }

      if (C.communitiesPagedInflight.has(cacheKey)) {
        recordEndpointListCache("communities", "coalesced");
        try {
          return res.json(await C.communitiesPagedInflight.get(cacheKey));
        } catch (err) {
          if (C.isCommunitiesTransientFailure(err) && !page.after) {
            const stale = await C.readLastGoodCommunitiesPayload(req.user.id);
            if (stale) {
              recordEndpointListCacheBypass("communities", "timeout");
              logger.warn(
                { err, userId: req.user.id },
                "GET /communities transient failure during coalesced fetch; serving stale cache",
              );
              return res.json(stale);
            }
          }
          if (C.isCommunitiesTransientFailure(err)) {
            logger.warn(
              { err, userId: req.user.id },
              "GET /communities transient failure during coalesced fetch",
            );
            return res.status(503).set("Retry-After", "1").json({
              error: "Communities are briefly unavailable; please retry.",
              requestId: req.id,
            });
          }
          return next(err);
        }
      }

      recordEndpointListCache("communities", "miss");
      const promise = withDistributedSingleflight({
        redis,
        cacheKey,
        inflight: C.communitiesPagedInflight,
        readFresh: async () => getJsonCache(redis, cacheKey),
        readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
        load: async () => {
          let cursorName = null;
          let cursorId = null;
          if (page.after) {
            const { rows: curRows } = await queryRead(
              `SELECT c.name, c.id
               FROM communities c
               LEFT JOIN community_members cm
                 ON cm.community_id = c.id AND cm.user_id = $1
               WHERE c.id = $2
                 AND (c.is_public = TRUE OR cm.user_id IS NOT NULL)`,
              [req.user.id, page.after],
            );
            if (!curRows.length) {
              const error: any = new Error("Invalid after cursor");
              error.statusCode = 400;
              throw error;
            }
            cursorName = curRows[0].name;
            cursorId = curRows[0].id;
          }

          const fetchLimit = page.limit + 1;
          const { rows } = await C.queryCommunitiesListPage(
            req.user.id,
            cursorName,
            cursorId,
            fetchLimit,
          );

          const hasMore = rows.length > page.limit;
          const slice = hasMore ? rows.slice(0, page.limit) : rows;
          const body: any = await C.buildCommunitiesListPayload(
            req.user.id,
            slice,
          );
          if (hasMore) body.nextAfter = slice[slice.length - 1].id;
          await setJsonCacheWithStale(
            redis,
            cacheKey,
            body,
            C.COMMUNITIES_PAGED_CACHE_TTL_SECS,
            {
              staleMultiplier: 1.25,
              maxStaleTtlSeconds: 240,
            },
          );
          if (!page.after) {
            C.writeLastGoodCommunitiesPayload(req.user.id, body);
          }
          return body;
        },
      });

      return res.json(await promise);
    } catch (err) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ error: "Invalid after cursor" });
      }
      if (C.isCommunitiesTransientFailure(err)) {
        logger.warn(
          { err, userId: req.user.id },
          "GET /communities (paged) transient failure",
        );
        return res.status(503).set("Retry-After", "1").json({
          error: "Communities are briefly unavailable; please retry.",
          requestId: req.id,
        });
      }
      return next(err);
    }
  }

  const publicVersion = await C.getPublicCommunitiesVersion();
  const cacheKey = C.communitiesCacheKey(req.user.id, publicVersion);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      recordEndpointListCache("communities", "hit");
      return res.json(JSON.parse(cached));
    }
  } catch {
    // cache miss – fall through to DB
  }

  if (C.communitiesInflight.has(cacheKey)) {
    recordEndpointListCache("communities", "coalesced");
    try {
      return res.json(await C.communitiesInflight.get(cacheKey));
    } catch (err) {
      if (C.isCommunitiesTransientFailure(err)) {
        const stale = await C.readLastGoodCommunitiesPayload(req.user.id);
        if (stale) {
          recordEndpointListCacheBypass("communities", "timeout");
          logger.warn(
            { err, userId: req.user.id },
            "GET /communities transient failure during coalesced fetch; serving stale cache",
          );
          return res.json(stale);
        }
        logger.warn(
          { err, userId: req.user.id },
          "GET /communities transient failure during coalesced fetch",
        );
        return res.status(503).set("Retry-After", "1").json({
          error: "Communities are briefly unavailable; please retry.",
          requestId: req.id,
        });
      }
      return next(err);
    }
  }

  recordEndpointListCache("communities", "miss");
  const promise: Promise<{ communities: any[] }> = (async () => {
    const { rows } = await C.queryCommunitiesListFull(req.user.id);
    const payload = await C.buildCommunitiesListPayload(req.user.id, rows);
    redis
      .setex(cacheKey, C.COMMUNITIES_CACHE_TTL_SECS, JSON.stringify(payload))
      .catch(() => {});
    C.writeLastGoodCommunitiesPayload(req.user.id, payload);
    return payload;
  })();

  C.communitiesInflight.set(cacheKey, promise);
  promise.finally(() => C.communitiesInflight.delete(cacheKey)).catch(() => {});

  try {
    res.json(await promise);
  } catch (err) {
    if (C.isCommunitiesTransientFailure(err)) {
      const stale = await C.readLastGoodCommunitiesPayload(req.user.id);
      if (stale) {
        recordEndpointListCacheBypass("communities", "timeout");
        logger.warn(
          { err, userId: req.user.id },
          "GET /communities transient failure; serving stale cache",
        );
        return res.json(stale);
      }
      logger.warn(
        { err, userId: req.user.id },
        "GET /communities transient failure",
      );
      return res.status(503).set("Retry-After", "1").json({
        error: "Communities are briefly unavailable; please retry.",
        requestId: req.id,
      });
    }
    next(err);
  }
});

};
