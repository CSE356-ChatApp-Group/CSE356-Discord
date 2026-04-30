/**
 * Redis key helpers for community caches.
 */

const PUBLIC_COMMUNITIES_VERSION_KEY = "communities:list:public_version";
const COMMUNITIES_USER_VERSION_KEY_PREFIX = "communities:list:user_version:";

function communitiesCacheKey(userId, publicVersion = "0") {
  return `communities:list:${userId}:v${publicVersion}`;
}

function communitiesPagedCacheKey(
  userId,
  publicVersion,
  userVersion,
  limit,
  after,
) {
  return `communities:list:${userId}:v${publicVersion}:uv${userVersion}:paged:l${limit}:a${after || "_"}`;
}

function communitiesUserVersionKey(userId) {
  return `${COMMUNITIES_USER_VERSION_KEY_PREFIX}${userId}`;
}

function communitiesLastGoodCacheKey(userId) {
  return `communities:list:last_good:${userId}`;
}

function membersCacheKey(communityId) {
  return `community:${communityId}:members`;
}

module.exports = {
  PUBLIC_COMMUNITIES_VERSION_KEY,
  COMMUNITIES_USER_VERSION_KEY_PREFIX,
  communitiesCacheKey,
  communitiesPagedCacheKey,
  communitiesUserVersionKey,
  communitiesLastGoodCacheKey,
  membersCacheKey,
};
