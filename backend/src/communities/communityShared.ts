/**
 * Shared communities router logic (cache keys, joins, list SQL, validation).
 * HTTP handlers live in `routes/*.ts`.
 */

const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const { validate: uuidValidate } = require("uuid");
const { body, param, validationResult } = require("express-validator");

const { query, queryRead, getClient } = require("../db/pool");
const redis = require("../db/redis");
const logger = require("../utils/logger");
const presenceService = require("../presence/service");
const fanout = require("../websocket/fanout");
const { publishUserFeedTargets } = require("../websocket/userFeed");
const {
  invalidateWsBootstrapCache,
  invalidateWsAclCache,
} = require("../websocket/server");
const {
  invalidateCommunityChannelUserFanoutTargetsCache,
  getCommunityChannelIds,
} = require("../messages/channelRealtimeFanout");
const {
  warmChannelAccessCacheForUser,
  evictChannelAccessCacheForUser,
} = require("../messages/channelAccessCache");
const {
  recordEndpointListCache,
  recordEndpointListCacheBypass,
} = require("../utils/endpointCacheMetrics");
const { apiRateLimitHitsTotal } = require("../utils/metrics");
const { recordAbuseStrikeFromRequest } = require("../utils/autoIpBan");
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require("../utils/distributedSingleflight");
const {
  getChannelLastMessageMetaMapFromRedis,
} = require("../messages/repointLastMessage");
const {
  incrCommunityMemberCount,
  decrCommunityMemberCount,
  getCommunityMemberCountsFromRedis,
} = require("./communityMemberCount");

function registerJoinPathGuard(router) {
  router.use((req, res, next) => {
    if (req.method !== "POST") return next();
    const path = String(req.path || "").replace(/\/$/, "") || "/";
    if (path !== "/join") return next();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const raw = String(
      body.communityId ??
        body.community_id ??
        body.id ??
        body.slug ??
        body.name ??
        "",
    ).trim();
    if (!raw) {
      return res
        .status(400)
        .json({ error: "Missing community id", requestId: req.id });
    }
    next();
  });
}

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

/**
 * Resolve :id for POST .../communities/:id/join: UUID looks up any community;
 * non-UUID matches a public community by exact slug or exact name (LIMIT 2 → ambiguous).
 */
async function resolveCommunityIdForPublicJoin(rawId) {
  const token = String(rawId ?? "").trim();
  if (!token) return { ok: false, reason: "missing" };
  if (token.length > 512) return { ok: false, reason: "invalid" };

  if (uuidValidate(token)) {
    const { rows } = await query(
      "SELECT id, is_public FROM communities WHERE id = $1",
      [token],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "notfound" };
    return { ok: true, id: row.id, isPublic: row.is_public };
  }

  const { rows } = await query(
    `SELECT id FROM communities
     WHERE is_public = true AND (slug = $1 OR name = $1)
     LIMIT 2`,
    [token],
  );
  if (rows.length === 0) return { ok: false, reason: "notfound" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, id: rows[0].id, isPublic: true };
}

/** Shared join implementation after resolveCommunityIdForPublicJoin. */
async function executeResolvedPublicJoin(req, res, next, resolved) {
  if (!resolved.ok) {
    if (resolved.reason === "missing" || resolved.reason === "invalid") {
      return res.status(400).json({ error: "Invalid community id" });
    }
    if (resolved.reason === "ambiguous") {
      return res
        .status(409)
        .json({ error: "Multiple communities match; use id or slug" });
    }
    return res.status(404).json({ error: "Community not found" });
  }

  if (!resolved.isPublic) {
    return res.status(403).json({ error: "Community is private" });
  }

  const communityId = resolved.id;

  try {
    const { rowCount } = await query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [communityId, req.user.id],
    );
    if (!rowCount) {
      return res.json({ success: true });
    }

    incrCommunityMemberCount(communityId).catch(() => {});

    const [realtimeTargets, channelIds] = await Promise.all([
      listCommunityRealtimeTargets(communityId, req.user.id),
      getCommunityChannelIds(communityId),
    ]);
    warmChannelAccessCacheForUser(redis, channelIds, req.user.id).catch(
      () => {},
    );

    await Promise.allSettled([
      invalidateCommunityChannelUserFanoutTargetsCache(communityId, channelIds),
      presenceService.invalidatePresenceFanoutTargets(req.user.id),
      invalidateWsBootstrapCache(req.user.id),
      publishUserFeedTargets([req.user.id], {
        __wsInternal: {
          kind: "subscribe_channels",
          channels: realtimeTargets,
        },
      }),
      publishUserFeedTargets([req.user.id], {
        __wsInternal: {
          kind: "subscribe_communities",
          communityIds: [communityId],
        },
      }),
    ]);
    invalidateWsAclCache(req.user.id, `community:${communityId}`);
    {
      const publicVersion = await getPublicCommunitiesVersion();
      invalidateCommunitiesCaches([req.user.id], publicVersion).catch(() => {});
    }
    redis.del(membersCacheKey(communityId)).catch(() => {});

    const communityJoinPayload = { userId: req.user.id, communityId };
    await fanout.publish(`community:${communityId}`, {
      event: "community:member_joined",
      data: communityJoinPayload,
    });
    await fanout.publish(`community:${communityId}`, {
      event: "community:joined",
      data: communityJoinPayload,
    });
    // GeneratedClient handleWsMessage matches community:invite | community:joined |
    // community:member_added (not community:member_joined). Emit member_added so
    // onInvite fires without relying on __wsInternal-only paths.
    await fanout.publish(`community:${communityId}`, {
      event: "community:member_added",
      data: communityJoinPayload,
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(req) {
  const realIp = req.headers["x-real-ip"];
  const firstRealIp = Array.isArray(realIp) ? realIp[0] : realIp;
  if (firstRealIp) return firstRealIp.trim();

  if (req.ip) return req.ip.trim();

  const forwardedFor = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  return (
    firstForwarded
      ? firstForwarded.split(",")[0]
      : req.socket?.remoteAddress || "unknown"
  ).trim();
}

function isInternalIp(ip) {
  const normalized = String(ip || "").replace(/^::ffff:/, "");
  const parts = normalized.split(".");
  const secondOctet = Number.parseInt(parts[1] || "", 10);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    ip === "::1" ||
    normalized.startsWith("10.") ||
    (parts[0] === "172" &&
      Number.isFinite(secondOctet) &&
      secondOctet >= 16 &&
      secondOctet <= 31) ||
    normalized.startsWith("192.168.")
  );
}

function communityJoinRateLimitNoop(_req, _res, next) {
  next();
}

function buildCommunityJoinIpRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "COMMUNITY_JOIN_PER_IP_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("COMMUNITY_JOIN_PER_IP_MAX", 300);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cji:${clientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:community_join:ip:",
    }),
    message: {
      error:
        "Too many community join requests from this network. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: "community_join_ip" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function buildCommunityJoinUserRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "COMMUNITY_JOIN_PER_USER_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("COMMUNITY_JOIN_PER_USER_MAX", 120);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cju:${req.user?.id || "anon"}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:community_join:user:",
    }),
    message: {
      error:
        "Too many community join requests from this account. Slow down and try again shortly.",
    },
    handler: (_req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: "community_join_user" });
      res.status(options.statusCode).json(options.message);
    },
  });
}

const communityJoinIpRateLimiter = buildCommunityJoinIpRateLimiter();
const communityJoinUserRateLimiter = buildCommunityJoinUserRateLimiter();

/** Middleware: load caller's community membership into req.membership */
async function loadMembership(req, res, next) {
  const { rows } = await query(
    "SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2",
    [req.params.id, req.user.id],
  );
  req.membership = rows[0] || null;
  next();
}

const _communitiesTtl = parseInt(
  process.env.COMMUNITIES_LIST_CACHE_TTL_SECS || "300",
  10,
);
const COMMUNITIES_CACHE_TTL_SECS =
  Number.isFinite(_communitiesTtl) && _communitiesTtl > 0
    ? _communitiesTtl
    : 300;
const _communitiesPagedTtl = parseInt(
  process.env.COMMUNITIES_PAGED_CACHE_TTL_SECS || "60",
  10,
);
const COMMUNITIES_PAGED_CACHE_TTL_SECS =
  Number.isFinite(_communitiesPagedTtl) && _communitiesPagedTtl > 0
    ? _communitiesPagedTtl
    : 60;
const _communitiesHeavyTimeout = parseInt(
  process.env.COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS || "2500",
  10,
);
const COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS =
  Number.isFinite(_communitiesHeavyTimeout) && _communitiesHeavyTimeout > 100
    ? _communitiesHeavyTimeout
    : 2500;
const _communitiesHeavyInflight = parseInt(
  process.env.COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT || "4",
  10,
);
const COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT =
  Number.isFinite(_communitiesHeavyInflight) && _communitiesHeavyInflight > 0
    ? _communitiesHeavyInflight
    : 4;
const PUBLIC_COMMUNITIES_VERSION_KEY = "communities:list:public_version";
const COMMUNITIES_USER_VERSION_KEY_PREFIX = "communities:list:user_version:";
let communitiesUnreadQueriesInFlight = 0;
const COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS = Math.max(
  COMMUNITIES_CACHE_TTL_SECS,
  900,
);
const _communitiesVersionTtl = parseInt(
  process.env.COMMUNITIES_VERSION_CACHE_TTL_SECS || "2592000",
  10,
);
const COMMUNITIES_VERSION_CACHE_TTL_SECS =
  Number.isFinite(_communitiesVersionTtl) && _communitiesVersionTtl > 0
    ? _communitiesVersionTtl
    : 2_592_000;

/** Unit tests stub `redis` with partial mocks; production ioredis has `expire`. */
async function redisExpireBestEffort(key, ttlSec) {
  if (typeof redis.expire !== "function") return;
  try {
    await redis.expire(key, ttlSec);
  } catch {
    /* ignore */
  }
}

const COMMUNITY_RETURNING_FIELDS = `
  id,
  slug,
  name,
  description,
  icon_url,
  owner_id,
  is_public,
  member_count,
  created_at,
  updated_at`;

const COMMUNITY_SELECT_FIELDS = `
  c.id,
  c.slug,
  c.name,
  c.description,
  c.icon_url,
  c.owner_id,
  c.is_public,
  c.member_count,
  c.created_at,
  c.updated_at`;

const COMMUNITY_DETAIL_CHANNEL_JSON = `
  json_build_object(
    'id', ch.id,
    'community_id', ch.community_id,
    'name', ch.name,
    'description', ch.description,
    'is_private', ch.is_private,
    'type', ch.type,
    'position', ch.position,
    'created_by', ch.created_by,
    'created_at', ch.created_at,
    'updated_at', ch.updated_at,
    'last_message_id', ch.last_message_id,
    'last_message_author_id', ch.last_message_author_id,
    'last_message_at', ch.last_message_at
  )
  ORDER BY ch.position`;

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

async function invalidateCommunitiesCaches(userIds, publicVersion = "0") {
  const normalizedUserIds = [
    ...new Set(
      (Array.isArray(userIds) ? userIds : []).filter(
        (userId) => typeof userId === "string" && userId,
      ),
    ),
  ];
  const keys = [
    ...new Set(
      normalizedUserIds.flatMap((userId) => {
        const key = communitiesCacheKey(userId, publicVersion);
        return [key, staleCacheKey(key)];
      }),
    ),
  ];
  if (keys.length > 0) {
    await redis.del(...new Set(keys));
  }
  await Promise.allSettled(
    normalizedUserIds.map(async (userId) => {
      const key = communitiesUserVersionKey(userId);
      await redis.incr(key);
      await redisExpireBestEffort(key, COMMUNITIES_VERSION_CACHE_TTL_SECS);
    }),
  );
}

async function getPublicCommunitiesVersion() {
  const v =
    (await redis.get(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => null)) || "0";
  void redisExpireBestEffort(
    PUBLIC_COMMUNITIES_VERSION_KEY,
    COMMUNITIES_VERSION_CACHE_TTL_SECS,
  );
  return v;
}

async function bumpPublicCommunitiesVersion() {
  try {
    await redis.incr(PUBLIC_COMMUNITIES_VERSION_KEY);
    await redisExpireBestEffort(
      PUBLIC_COMMUNITIES_VERSION_KEY,
      COMMUNITIES_VERSION_CACHE_TTL_SECS,
    );
  } catch {
    // Best-effort only.
  }
}

async function getCommunitiesUserVersion(userId) {
  const key = communitiesUserVersionKey(userId);
  const v = (await redis.get(key).catch(() => null)) || "0";
  void redisExpireBestEffort(key, COMMUNITIES_VERSION_CACHE_TTL_SECS);
  return v;
}

const MEMBERS_CACHE_TTL_SECS = 30;
function membersCacheKey(communityId) {
  return `community:${communityId}:members`;
}
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

async function listCommunityRealtimeTargets(communityId, userId) {
  // Primary (not replica): right after INSERT community_members, replica lag can
  // return an empty or partial channel list so WS subscribe_channels misses
  // channel:<id> topics until reconnect — correlates with grader delivery timeouts.
  const { rows } = await query(
    `SELECT c.id::text AS id
     FROM channels c
     LEFT JOIN channel_members chm
       ON chm.channel_id = c.id
      AND chm.user_id = $2
     WHERE c.community_id = $1
       AND (c.is_private = FALSE OR chm.user_id IS NOT NULL)
     ORDER BY c.id`,
    [communityId, userId],
  );

  return [
    `community:${communityId}`,
    ...rows.map((row) => `channel:${row.id}`),
  ];
}

// In-process singleflight: prevents thundering-herd when cache expires.
const communitiesInflight: Map<
  string,
  Promise<{ communities: any[] }>
> = new Map();
const communitiesPagedInflight: Map<string, Promise<any>> = new Map();

async function cleanupCommunityUnreadCounterKeys(communityId) {
  try {
    const { rows } = await queryRead(
      "SELECT id::text FROM channels WHERE community_id = $1",
      [communityId],
    );
    if (!rows.length) return;
    const channelKeys = rows.map((row) => `channel:msg_count:${row.id}`);
    await redis.del(...channelKeys);
  } catch {
    // Best-effort cleanup; never block community deletion.
  }
}

/**
 * Full visible list (no limit). member_count is denormalized on communities (no live aggregate).
 * $1 = user_id
 */
const COMMUNITIES_LIST_FULL_SQL = `
SELECT c.id,
       c.slug,
       c.name,
       c.description,
       c.icon_url,
       c.is_public,
       c.owner_id,
       c.created_at,
       c.updated_at,
       cm.role AS my_role,
       c.member_count
FROM communities c
LEFT JOIN community_members cm
  ON cm.community_id = c.id
 AND cm.user_id = $1
WHERE (c.is_public = TRUE OR cm.user_id IS NOT NULL)
ORDER BY c.name, c.id`;

/**
 * Keyset page; member_count from denormalized column on communities.
 * $1 user_id, $2 cursor name (nullable), $3 cursor id (nullable), $4 fetch limit (page size + 1).
 */
const COMMUNITIES_LIST_PAGE_SQL = `
SELECT c.id,
       c.slug,
       c.name,
       c.description,
       c.icon_url,
       c.is_public,
       c.owner_id,
       c.created_at,
       c.updated_at,
       cm.role AS my_role,
       c.member_count
FROM communities c
LEFT JOIN community_members cm
  ON cm.community_id = c.id
 AND cm.user_id = $1
WHERE (c.is_public = TRUE OR cm.user_id IS NOT NULL)
  AND (($2::text IS NULL AND $3::uuid IS NULL) OR (c.name, c.id) > ($2::text, $3::uuid))
ORDER BY c.name, c.id
LIMIT $4`;

function isCommunitiesTimeout(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.code === "57014" ||
    msg.includes("statement timeout") ||
    msg.includes("query read timeout") ||
    msg.includes("query timed out")
  );
}

function isCommunitiesTransientFailure(err) {
  if (isCommunitiesTimeout(err)) return true;
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.code === "POOL_CIRCUIT_OPEN" ||
    err?.name === "PoolTimeoutError" ||
    err?.code === "57014" ||
    (/timeout exceeded/i.test(msg) &&
      /(connect|client|connection|waiting)/i.test(msg)) ||
    msg.includes("waiting for a client") ||
    msg.includes("remaining connection slots") ||
    msg.includes("too many clients")
  );
}

async function readLastGoodCommunitiesPayload(userId) {
  try {
    const raw = await redis.get(communitiesLastGoodCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.communities)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function writeLastGoodCommunitiesPayload(userId, payload) {
  redis
    .setex(
      communitiesLastGoodCacheKey(userId),
      COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS,
      JSON.stringify(payload),
    )
    .catch(() => {});
}

async function queryCommunitiesListFull(userId) {
  return query({
    text: COMMUNITIES_LIST_FULL_SQL,
    values: [userId],
    query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
  });
}

async function queryCommunitiesListPage(
  userId,
  cursorName,
  cursorId,
  fetchLimit,
) {
  return query({
    text: COMMUNITIES_LIST_PAGE_SQL,
    values: [userId, cursorName, cursorId, fetchLimit],
    query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
  });
}

async function fetchUnreadCountsForCommunities(userId, communityIds) {
  if (!communityIds.length) return new Map();
  if (
    communitiesUnreadQueriesInFlight >= COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT
  ) {
    recordEndpointListCacheBypass("communities", "pressure");
    return new Map();
  }

  communitiesUnreadQueriesInFlight += 1;
  try {
    const { rows } = await queryRead({
      text: `
        SELECT ch.community_id, COUNT(*)::int AS unread_channel_count
        FROM channels ch
        LEFT JOIN channel_members chm
          ON chm.channel_id = ch.id
         AND chm.user_id = $1
        LEFT JOIN read_states rs
          ON rs.channel_id = ch.id
         AND rs.user_id = $1
        WHERE ch.community_id = ANY($2::uuid[])
          AND (ch.is_private = FALSE OR chm.user_id IS NOT NULL)
          AND ch.last_message_id IS NOT NULL
          AND ch.last_message_author_id IS DISTINCT FROM $1
          AND rs.last_read_message_id IS DISTINCT FROM ch.last_message_id
        GROUP BY ch.community_id`,
      values: [userId, communityIds],
      // Keep unread calculation bounded; route remains available with zero unread fallback.
      query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
    });
    return new Map(
      rows.map((row) => [
        row.community_id,
        Number(row.unread_channel_count || 0),
      ]),
    );
  } catch (err) {
    if (isCommunitiesTimeout(err)) {
      logger.warn(
        { err },
        "Communities unread-count query timed out; using unread=0 fallback",
      );
      recordEndpointListCacheBypass("communities", "timeout");
      return new Map();
    }
    throw err;
  } finally {
    communitiesUnreadQueriesInFlight = Math.max(
      0,
      communitiesUnreadQueriesInFlight - 1,
    );
  }
}

async function buildCommunitiesListPayload(userId, rows) {
  const communityIds = rows.map((row) => row.id);
  const [unreadByCommunity, memberCountByRedis] = await Promise.all([
    fetchUnreadCountsForCommunities(userId, communityIds),
    getCommunityMemberCountsFromRedis(communityIds),
  ]);
  return {
    communities: rows.map((row) => {
      const unread = unreadByCommunity.get(row.id) || 0;
      const redisCount = memberCountByRedis.get(row.id);
      return {
        ...row,
        member_count: redisCount !== undefined ? redisCount : row.member_count,
        unread_channel_count: unread,
        has_unread_channels: unread > 0,
      };
    }),
  };
}

function applyCommunityChannelLastMessageMetadata(channels, latestByChannel) {
  if (!Array.isArray(channels) || !channels.length || !latestByChannel?.size)
    return;
  for (const ch of channels) {
    const latest = latestByChannel.get(ch.id);
    if (!latest) continue;
    ch.last_message_id = latest.msg_id;
    ch.last_message_author_id = latest.author_id || null;
    ch.last_message_at = latest.at || null;
  }
}

function parseCommunitiesPageQuery(req) {
  const rawL = req.query.limit;
  const rawA = req.query.after;
  let limit = null;
  if (rawL !== undefined && String(rawL).length) {
    const n = parseInt(String(rawL), 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return { error: "limit must be an integer from 1 to 100" };
    }
    limit = n;
  }
  let after = null;
  if (rawA !== undefined && String(rawA).length) {
    const s = String(rawA).trim();
    if (!uuidValidate(s)) return { error: "after must be a UUID" };
    after = s;
  }
  if (after && !limit) return { error: "after requires limit" };
  return { limit, after };
}

module.exports = {
  registerJoinPathGuard,
  validate,
  resolveCommunityIdForPublicJoin,
  executeResolvedPublicJoin,
  parsePositiveIntEnv,
  clientIp,
  isInternalIp,
  communityJoinRateLimitNoop,
  buildCommunityJoinIpRateLimiter,
  buildCommunityJoinUserRateLimiter,
  communityJoinIpRateLimiter,
  communityJoinUserRateLimiter,
  loadMembership,
  _communitiesTtl,
  COMMUNITIES_CACHE_TTL_SECS,
  _communitiesPagedTtl,
  COMMUNITIES_PAGED_CACHE_TTL_SECS,
  _communitiesHeavyTimeout,
  COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
  _communitiesHeavyInflight,
  COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT,
  PUBLIC_COMMUNITIES_VERSION_KEY,
  COMMUNITIES_USER_VERSION_KEY_PREFIX,
  COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS,
  _communitiesVersionTtl,
  COMMUNITIES_VERSION_CACHE_TTL_SECS,
  redisExpireBestEffort,
  COMMUNITY_RETURNING_FIELDS,
  COMMUNITY_SELECT_FIELDS,
  COMMUNITY_DETAIL_CHANNEL_JSON,
  communitiesCacheKey,
  communitiesPagedCacheKey,
  communitiesUserVersionKey,
  communitiesLastGoodCacheKey,
  invalidateCommunitiesCaches,
  getPublicCommunitiesVersion,
  bumpPublicCommunitiesVersion,
  getCommunitiesUserVersion,
  MEMBERS_CACHE_TTL_SECS,
  membersCacheKey,
  communityMembersInflight,
  COMMUNITY_MEMBERS_ROSTER_SQL,
  hydrateCommunityMembersFromIds,
  readMembersCacheValue,
  loadCommunityMembersRoster,
  listCommunityRealtimeTargets,
  communitiesInflight,
  communitiesPagedInflight,
  cleanupCommunityUnreadCounterKeys,
  COMMUNITIES_LIST_FULL_SQL,
  COMMUNITIES_LIST_PAGE_SQL,
  isCommunitiesTimeout,
  isCommunitiesTransientFailure,
  readLastGoodCommunitiesPayload,
  writeLastGoodCommunitiesPayload,
  queryCommunitiesListFull,
  queryCommunitiesListPage,
  fetchUnreadCountsForCommunities,
  buildCommunitiesListPayload,
  applyCommunityChannelLastMessageMetadata,
  parseCommunitiesPageQuery,
};
