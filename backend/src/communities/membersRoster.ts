/**
 * Community members roster loading + cache hydration.
 */

const { query } = require("../db/pool");
const redis = require("../db/redis");
const { getJsonCache, withDistributedSingleflight } = require("../utils/distributedSingleflight");
const { membersCacheKey } = require("./cacheKeys");

const MEMBERS_CACHE_TTL_SECS = 30;
const communityMembersInflight: Map<string, Promise<any[]>> = new Map();
const COMMUNITY_MEMBERS_ROSTER_SQL = `
  SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role, cm.joined_at
  FROM community_members cm
  JOIN users u ON u.id = cm.user_id
  WHERE cm.community_id = $1
  ORDER BY cm.role DESC, u.username`;

/** Hydrate `{ id, role, joined_at }[]` with user profile fields (smaller Redis payload than full rows). */
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
      const minimal = rows.map((r) => ({
        id: r.id,
        role: r.role,
        joined_at: r.joined_at,
      }));
      redis
        .setex(
          cacheKey,
          MEMBERS_CACHE_TTL_SECS,
          JSON.stringify({ v: 2, members: minimal }),
        )
        .catch(() => {});
      return rows;
    },
  });
}

module.exports = {
  MEMBERS_CACHE_TTL_SECS,
  communityMembersInflight,
  COMMUNITY_MEMBERS_ROSTER_SQL,
  hydrateCommunityMembersFromIds,
  readMembersCacheValue,
  loadCommunityMembersRoster,
};
