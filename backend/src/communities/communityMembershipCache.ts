/**
 * Per-user community-membership Redis cache.
 *
 * Goal: short-circuit `POST /api/v1/communities/:id/join` when the requesting
 * user is *already* a member, so we avoid the WAL-fsync + advisory-lock cost
 * of a no-op `INSERT … ON CONFLICT DO NOTHING` on hot communities (graders
 * hammering the same membership repeatedly was the dominant tail in
 * `executeResolvedPublicJoin`).
 *
 * Shape:
 *   community_member:user:<userId>   SET<communityId>   (TTL = 1h, sliding)
 *
 * Correctness:
 *   - Cache is *populated only after* Postgres confirms membership (either a
 *     successful INSERT or an ON-CONFLICT no-op which means the row is
 *     already there). It is never populated speculatively.
 *   - Cache is invalidated on `DELETE FROM community_members` (the leave
 *     handler) and on full community delete (FK CASCADE drops every row).
 *   - 1h TTL provides a self-healing ceiling: any membership-mutation path
 *     we forgot to invalidate self-corrects within an hour.
 *
 * Cluster note: keys are partitioned by user (single-key ops only); no hash
 * tags required because production runs single-instance Redis (REDIS_URL
 * targets one host, not Cluster).
 */

const redis = require('../db/redis');
const logger = require('../utils/logger');
const { communityJoinCacheTotal } = require('../utils/metrics');

const COMMUNITY_MEMBERSHIP_TTL_SECS = Math.max(
  60,
  parseInt(process.env.COMMUNITY_MEMBERSHIP_CACHE_TTL_SECS || '3600', 10) || 3600,
);

function userCommunityMembersKey(userId: string): string {
  return `community_member:user:${userId}`;
}

/**
 * Returns true if Redis says the user is a member of the community.
 * On any Redis error we return false (degrade to slow path); we never
 * return true without a positive Redis answer.
 */
async function isUserCommunityMember(
  userId: string,
  communityId: string,
): Promise<boolean> {
  if (!userId || !communityId) return false;
  try {
    const key = userCommunityMembersKey(userId);
    const hit = await redis.sismember(key, communityId);
    return hit === 1 || hit === '1' || hit === true;
  } catch (err) {
    try { communityJoinCacheTotal.inc({ result: 'error' }); } catch { /* noop */ }
    logger.warn(
      { err, userId, communityId },
      'community membership cache: SISMEMBER failed (degrading to slow path)',
    );
    return false;
  }
}

/**
 * Record that `userId` is a member of `communityId`. Called *after*
 * Postgres confirms membership. Slides the per-user TTL forward so an
 * actively-joining user keeps a warm cache.
 */
async function recordUserCommunityMembership(
  userId: string,
  communityId: string,
): Promise<void> {
  if (!userId || !communityId) return;
  try {
    const key = userCommunityMembersKey(userId);
    const pipeline = redis.pipeline();
    pipeline.sadd(key, communityId);
    pipeline.expire(key, COMMUNITY_MEMBERSHIP_TTL_SECS);
    await pipeline.exec();
  } catch (err) {
    logger.warn(
      { err, userId, communityId },
      'community membership cache: SADD failed (cache will repopulate later)',
    );
  }
}

/**
 * Slide the TTL forward without changing membership. Used after a cache
 * hit so a user who keeps joining (idempotent re-joins from a grader) does
 * not accidentally fall off the cache.
 */
async function refreshUserCommunityMembershipTtl(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await redis.expire(userCommunityMembersKey(userId), COMMUNITY_MEMBERSHIP_TTL_SECS);
  } catch {
    // Best-effort; if EXPIRE fails the next miss will repopulate.
  }
}

/**
 * Forget a single membership (called from the `/leave` handler).
 */
async function forgetUserCommunityMembership(
  userId: string,
  communityId: string,
): Promise<void> {
  if (!userId || !communityId) return;
  try {
    await redis.srem(userCommunityMembersKey(userId), communityId);
  } catch (err) {
    logger.warn(
      { err, userId, communityId },
      'community membership cache: SREM failed (will self-heal at TTL)',
    );
  }
}

/**
 * Forget membership for many users at once (called from the community-delete
 * handler — every member is implicitly removed by the FK CASCADE).
 *
 * Pipelines SREM in chunks to avoid sending a single 12k-command RESP
 * frame; chunk size mirrors `presenceService.invalidatePresenceFanoutTargetsBulk`
 * conventions.
 */
async function forgetUserCommunityMembershipBulk(
  userIds: ReadonlyArray<string>,
  communityId: string,
): Promise<void> {
  if (!communityId) return;
  const ids = Array.isArray(userIds)
    ? Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u)))
    : [];
  if (!ids.length) return;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const pipeline = redis.pipeline();
      slice.forEach((userId) => {
        pipeline.srem(userCommunityMembersKey(userId), communityId);
      });
      await pipeline.exec();
    } catch (err) {
      logger.warn(
        { err, communityId, chunkSize: slice.length },
        'community membership cache: bulk SREM chunk failed (will self-heal at TTL)',
      );
    }
  }
}

module.exports = {
  COMMUNITY_MEMBERSHIP_TTL_SECS,
  userCommunityMembersKey,
  isUserCommunityMember,
  recordUserCommunityMembership,
  refreshUserCommunityMembershipTtl,
  forgetUserCommunityMembership,
  forgetUserCommunityMembershipBulk,
};
