/**
 * Community members roster loading + cache hydration.
 */

const { query } = require("../db/pool");
const redis = require("../db/redis");
const { redisBatchUnlink } = require("../db/redisBatch");
const { getJsonCache, withDistributedSingleflight } = require("../utils/distributedSingleflight");
const { membersCacheKey } = require("./cacheKeys");

const MEMBERS_CACHE_TTL_SECS = 30;
const FULL_ROSTER_CACHE_VERSION = 3;
const communityMembersInflight: Map<string, Promise<any[]>> = new Map();
const COMMUNITY_MEMBERS_ROSTER_SQL = `
  SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role, cm.joined_at
  FROM community_members cm
  JOIN users u ON u.id = cm.user_id
  WHERE cm.community_id = $1
  ORDER BY cm.role DESC, u.username`;

/** Backward-compatible hydration for legacy v2 caches that stored only ids + role metadata. */
async function hydrateCommunityMembersFromIds(minimal) {
  const ids = (Array.isArray(minimal) ? minimal : [])
    .map((m) => (m && typeof m.id === "string" ? m.id : null))
    .filter(Boolean);
  if (!ids.length) return [];
  const { rows: userRows } = await query(
    `SELECT id, username, display_name, avatar_url
       FROM users
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const userById = new Map(userRows.map((u: any) => [String(u.id), u]));
  return minimal.map((m: any) => {
    const u = (userById.get(String(m.id)) as any) || {};
    return {
      id: m.id,
      username: u.username,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      role: m.role,
      joined_at: m.joined_at,
    };
  });
}

async function readMembersCacheValue(cacheKey) {
  const raw = await getJsonCache(redis, cacheKey);
  if (!raw) return null;
  if (
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.v === FULL_ROSTER_CACHE_VERSION &&
    Array.isArray(raw.members)
  ) {
    return raw.members;
  }
  if (
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.v === 2 &&
    Array.isArray(raw.members)
  ) {
    return await hydrateCommunityMembersFromIds(raw.members);
  }
  if (Array.isArray(raw) && raw.length) return raw;
  return null;
}

async function loadCommunityMembersRoster(communityId) {
  const cacheKey = membersCacheKey(communityId);
  const cached = await readMembersCacheValue(cacheKey);
  if (cached) return cached;

  return withDistributedSingleflight({
    redis,
    cacheKey,
    inflight: communityMembersInflight,
    readFresh: async () => {
      const fresh = await readMembersCacheValue(cacheKey);
      return fresh;
    },
    load: async () => {
      const { rows } = await query(COMMUNITY_MEMBERS_ROSTER_SQL, [communityId]);
      const cachedMembers = rows.map((r) => ({
        id: r.id,
        username: r.username,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        role: r.role,
        joined_at: r.joined_at,
      }));
      redis
        .setex(
          cacheKey,
          MEMBERS_CACHE_TTL_SECS,
          JSON.stringify({ v: FULL_ROSTER_CACHE_VERSION, members: cachedMembers }),
        )
        .catch(() => {});
      return rows;
    },
  });
}

async function invalidateCommunityMemberRostersForUser(userId) {
  if (typeof userId !== "string" || !userId) return;
  const { rows } = await query(
    `SELECT community_id::text AS community_id
       FROM community_members
      WHERE user_id = $1`,
    [userId],
  );
  const keys = [...new Set(
    rows
      .map((row: any) => row.community_id)
      .filter((communityId: string | null) => typeof communityId === "string" && communityId)
      .map((communityId: string) => membersCacheKey(communityId))
  )];
  if (!keys.length) return;
  await redisBatchUnlink(redis, keys);
}

module.exports = {
  MEMBERS_CACHE_TTL_SECS,
  FULL_ROSTER_CACHE_VERSION,
  communityMembersInflight,
  COMMUNITY_MEMBERS_ROSTER_SQL,
  hydrateCommunityMembersFromIds,
  readMembersCacheValue,
  loadCommunityMembersRoster,
  invalidateCommunityMemberRostersForUser,
};
