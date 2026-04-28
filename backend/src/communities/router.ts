/**
 * Communities routes
 *
 * GET    /api/v1/communities                    – list public + joined (full list; optional ?limit=&after= keyset paging)
 * POST   /api/v1/communities                    – create
 * GET    /api/v1/communities/:id                – get details
 * DELETE /api/v1/communities/:id                – delete (owner only)
 * PATCH  /api/v1/communities/:id                – update (admin+)
 * POST   /api/v1/communities/join               – join (JSON: communityId | id | slug | name)
 * POST   /api/v1/communities/:id/join           – join public community (id UUID, or exact slug/name)
 * DELETE /api/v1/communities/:id/leave          – leave
 * GET    /api/v1/communities/:id/members        – list members + presence
 * PATCH  /api/v1/communities/:id/members/:userId – owner-only role update
 */

'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { validate: uuidValidate } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const { query, queryRead, getClient } = require('../db/pool');
const redis            = require('../db/redis');
const logger           = require('../utils/logger');
const { authenticate } = require('../middleware/authenticate');
const presenceService  = require('../presence/service');
const fanout           = require('../websocket/fanout');
const { publishUserFeedTargets } = require('../websocket/userFeed');
const { invalidateWsBootstrapCache, invalidateWsAclCache } = require('../websocket/server');
const { invalidateCommunityChannelUserFanoutTargetsCache, getCommunityChannelIds } = require('../messages/channelRealtimeFanout');
const { warmChannelAccessCacheForUser, evictChannelAccessCacheForUser } = require('../messages/channelAccessCache');
const { recordEndpointListCache, recordEndpointListCacheBypass } = require('../utils/endpointCacheMetrics');
const { apiRateLimitHitsTotal } = require('../utils/metrics');
const { recordAbuseStrikeFromRequest } = require('../utils/autoIpBan');
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require('../utils/distributedSingleflight');
const { getChannelLastMessageMetaMapFromRedis } = require('../messages/repointLastMessage');
const {
  incrCommunityMemberCount,
  decrCommunityMemberCount,
  getCommunityMemberCountsFromRedis,
} = require('./communityMemberCount');

const router = express.Router();

// POST /join with no id in body: 400 before auth (clearer than 401 for malformed harnesses + tests).
router.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const path = String(req.path || '').replace(/\/$/, '') || '/';
  if (path !== '/join') return next();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = String(
    body.communityId ?? body.community_id ?? body.id ?? body.slug ?? body.name ?? ''
  ).trim();
  if (!raw) {
    return res.status(400).json({ error: 'Missing community id', requestId: req.id });
  }
  next();
});

router.use(authenticate);

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ errors: errors.array() }); return false; }
  return true;
}

/**
 * Resolve :id for POST .../communities/:id/join: UUID looks up any community;
 * non-UUID matches a public community by exact slug or exact name (LIMIT 2 → ambiguous).
 */
async function resolveCommunityIdForPublicJoin(rawId) {
  const token = String(rawId ?? '').trim();
  if (!token) return { ok: false, reason: 'missing' };
  if (token.length > 512) return { ok: false, reason: 'invalid' };

  if (uuidValidate(token)) {
    const { rows } = await query(
      'SELECT id, is_public FROM communities WHERE id = $1',
      [token]
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: 'notfound' };
    return { ok: true, id: row.id, isPublic: row.is_public };
  }

  const { rows } = await query(
    `SELECT id FROM communities
     WHERE is_public = true AND (slug = $1 OR name = $1)
     LIMIT 2`,
    [token]
  );
  if (rows.length === 0) return { ok: false, reason: 'notfound' };
  if (rows.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, id: rows[0].id, isPublic: true };
}

/** Shared join implementation after resolveCommunityIdForPublicJoin. */
async function executeResolvedPublicJoin(req, res, next, resolved) {
  if (!resolved.ok) {
    if (resolved.reason === 'missing' || resolved.reason === 'invalid') {
      return res.status(400).json({ error: 'Invalid community id' });
    }
    if (resolved.reason === 'ambiguous') {
      return res.status(409).json({ error: 'Multiple communities match; use id or slug' });
    }
    return res.status(404).json({ error: 'Community not found' });
  }

  if (!resolved.isPublic) {
    return res.status(403).json({ error: 'Community is private' });
  }

  const communityId = resolved.id;

  try {
    const { rowCount } = await query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [communityId, req.user.id]
    );
    if (!rowCount) {
      return res.json({ success: true });
    }

    incrCommunityMemberCount(communityId).catch(() => {});

    const [realtimeTargets, channelIds] = await Promise.all([
      listCommunityRealtimeTargets(communityId, req.user.id),
      getCommunityChannelIds(communityId),
    ]);
    warmChannelAccessCacheForUser(redis, channelIds, req.user.id).catch(() => {});

    await Promise.allSettled([
      invalidateCommunityChannelUserFanoutTargetsCache(communityId, channelIds),
      presenceService.invalidatePresenceFanoutTargets(req.user.id),
      invalidateWsBootstrapCache(req.user.id),
      publishUserFeedTargets([req.user.id], {
        __wsInternal: {
          kind: 'subscribe_channels',
          channels: realtimeTargets,
        },
      }),
    ]);
    invalidateWsAclCache(req.user.id, `community:${communityId}`);
    {
      const publicVersion = await getPublicCommunitiesVersion();
      invalidateCommunitiesCaches([req.user.id], publicVersion).catch(() => {});
    }
    redis.del(membersCacheKey(communityId)).catch(() => {});

    await fanout.publish(`community:${communityId}`, {
      event: 'community:member_joined',
      data: { userId: req.user.id, communityId },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(req) {
  const realIp = req.headers['x-real-ip'];
  const firstRealIp = Array.isArray(realIp) ? realIp[0] : realIp;
  if (firstRealIp) return firstRealIp.trim();

  if (req.ip) return req.ip.trim();

  const forwardedFor = req.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return (firstForwarded ? firstForwarded.split(',')[0] : req.socket?.remoteAddress || 'unknown').trim();
}

function isInternalIp(ip) {
  const normalized = String(ip || '').replace(/^::ffff:/, '');
  const parts = normalized.split('.');
  const secondOctet = Number.parseInt(parts[1] || '', 10);
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || ip === '::1'
    || normalized.startsWith('10.')
    || (parts[0] === '172' && Number.isFinite(secondOctet) && secondOctet >= 16 && secondOctet <= 31)
    || normalized.startsWith('192.168.');
}

function communityJoinRateLimitNoop(_req, _res, next) {
  next();
}

function buildCommunityJoinIpRateLimiter() {
  if (process.env.DISABLE_RATE_LIMITS === 'true' || process.env.NODE_ENV === 'test') {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv('COMMUNITY_JOIN_PER_IP_WINDOW_MS', 60_000);
  const limit = parsePositiveIntEnv('COMMUNITY_JOIN_PER_IP_MAX', 300);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cji:${clientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: 'rl:community_join:ip:',
    }),
    message: { error: 'Too many community join requests from this network. Slow down and try again shortly.' },
    handler: (req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: 'community_join_ip' });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function buildCommunityJoinUserRateLimiter() {
  if (process.env.DISABLE_RATE_LIMITS === 'true' || process.env.NODE_ENV === 'test') {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv('COMMUNITY_JOIN_PER_USER_WINDOW_MS', 60_000);
  const limit = parsePositiveIntEnv('COMMUNITY_JOIN_PER_USER_MAX', 120);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cju:${req.user?.id || 'anon'}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: 'rl:community_join:user:',
    }),
    message: { error: 'Too many community join requests from this account. Slow down and try again shortly.' },
    handler: (_req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: 'community_join_user' });
      res.status(options.statusCode).json(options.message);
    },
  });
}

const communityJoinIpRateLimiter = buildCommunityJoinIpRateLimiter();
const communityJoinUserRateLimiter = buildCommunityJoinUserRateLimiter();

/** Middleware: load caller's community membership into req.membership */
async function loadMembership(req, res, next) {
  const { rows } = await query(
    'SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  req.membership = rows[0] || null;
  next();
}

const _communitiesTtl = parseInt(process.env.COMMUNITIES_LIST_CACHE_TTL_SECS || '300', 10);
const COMMUNITIES_CACHE_TTL_SECS =
  Number.isFinite(_communitiesTtl) && _communitiesTtl > 0 ? _communitiesTtl : 300;
const _communitiesPagedTtl = parseInt(process.env.COMMUNITIES_PAGED_CACHE_TTL_SECS || '60', 10);
const COMMUNITIES_PAGED_CACHE_TTL_SECS =
  Number.isFinite(_communitiesPagedTtl) && _communitiesPagedTtl > 0 ? _communitiesPagedTtl : 60;
const _communitiesHeavyTimeout = parseInt(process.env.COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS || '2500', 10);
const COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS =
  Number.isFinite(_communitiesHeavyTimeout) && _communitiesHeavyTimeout > 100
    ? _communitiesHeavyTimeout
    : 2500;
const _communitiesHeavyInflight = parseInt(process.env.COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT || '4', 10);
const COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT =
  Number.isFinite(_communitiesHeavyInflight) && _communitiesHeavyInflight > 0
    ? _communitiesHeavyInflight
    : 4;
const PUBLIC_COMMUNITIES_VERSION_KEY = 'communities:list:public_version';
const COMMUNITIES_USER_VERSION_KEY_PREFIX = 'communities:list:user_version:';
let communitiesUnreadQueriesInFlight = 0;
const COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS = Math.max(
  COMMUNITIES_CACHE_TTL_SECS,
  900,
);
const _communitiesVersionTtl = parseInt(process.env.COMMUNITIES_VERSION_CACHE_TTL_SECS || '2592000', 10);
const COMMUNITIES_VERSION_CACHE_TTL_SECS =
  Number.isFinite(_communitiesVersionTtl) && _communitiesVersionTtl > 0 ? _communitiesVersionTtl : 2_592_000;

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

function communitiesCacheKey(userId, publicVersion = '0') {
  return `communities:list:${userId}:v${publicVersion}`;
}

function communitiesPagedCacheKey(userId, publicVersion, userVersion, limit, after) {
  return `communities:list:${userId}:v${publicVersion}:uv${userVersion}:paged:l${limit}:a${after || '_'}`;
}

function communitiesUserVersionKey(userId) {
  return `${COMMUNITIES_USER_VERSION_KEY_PREFIX}${userId}`;
}

function communitiesLastGoodCacheKey(userId) {
  return `communities:list:last_good:${userId}`;
}

async function invalidateCommunitiesCaches(userIds, publicVersion = '0') {
  const normalizedUserIds = [...new Set(
    (Array.isArray(userIds) ? userIds : []).filter((userId) => typeof userId === 'string' && userId),
  )];
  const keys = [...new Set(
    normalizedUserIds.flatMap((userId) => {
      const key = communitiesCacheKey(userId, publicVersion);
      return [key, staleCacheKey(key)];
    })
  )];
  if (keys.length > 0) {
    await redis.del(...new Set(keys));
  }
  await Promise.allSettled(
    normalizedUserIds.map(async (userId) => {
      const key = communitiesUserVersionKey(userId);
      await redis.incr(key);
      await redis.expire(key, COMMUNITIES_VERSION_CACHE_TTL_SECS);
    }),
  );
}

async function getPublicCommunitiesVersion() {
  const v = (await redis.get(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => null)) || '0';
  redis.expire(PUBLIC_COMMUNITIES_VERSION_KEY, COMMUNITIES_VERSION_CACHE_TTL_SECS).catch(() => {});
  return v;
}

async function bumpPublicCommunitiesVersion() {
  try {
    await redis.incr(PUBLIC_COMMUNITIES_VERSION_KEY);
    await redis.expire(PUBLIC_COMMUNITIES_VERSION_KEY, COMMUNITIES_VERSION_CACHE_TTL_SECS);
  } catch {
    // Best-effort only.
  }
}

async function getCommunitiesUserVersion(userId) {
  const key = communitiesUserVersionKey(userId);
  const v = (await redis.get(key).catch(() => null)) || '0';
  redis.expire(key, COMMUNITIES_VERSION_CACHE_TTL_SECS).catch(() => {});
  return v;
}

const MEMBERS_CACHE_TTL_SECS = 30;
function membersCacheKey(communityId) { return `community:${communityId}:members`; }
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
    .map((m) => (m && typeof m.id === 'string' ? m.id : null))
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
    const u = userById.get(String(m.id)) as any || {};
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
  if (typeof raw === 'object' && !Array.isArray(raw) && raw.v === 2 && Array.isArray(raw.members)) {
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
        .setex(cacheKey, MEMBERS_CACHE_TTL_SECS, JSON.stringify({ v: 2, members: minimal }))
        .catch(() => {});
      return rows;
    },
  });
}

async function listCommunityRealtimeTargets(communityId, userId) {
  const { rows } = await queryRead(
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
const communitiesInflight: Map<string, Promise<{ communities: any[] }>> = new Map();
const communitiesPagedInflight: Map<string, Promise<any>> = new Map();

async function cleanupCommunityUnreadCounterKeys(communityId) {
  try {
    const { rows } = await queryRead('SELECT id::text FROM channels WHERE community_id = $1', [communityId]);
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
  const msg = String(err?.message || '').toLowerCase();
  return (
    err?.code === '57014'
    || msg.includes('statement timeout')
    || msg.includes('query read timeout')
    || msg.includes('query timed out')
  );
}

function isCommunitiesTransientFailure(err) {
  if (isCommunitiesTimeout(err)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    err?.code === 'POOL_CIRCUIT_OPEN'
    || err?.name === 'PoolTimeoutError'
    || err?.code === '57014'
    || (/timeout exceeded/i.test(msg) && /(connect|client|connection|waiting)/i.test(msg))
    || msg.includes('waiting for a client')
    || msg.includes('remaining connection slots')
    || msg.includes('too many clients')
  );
}

async function readLastGoodCommunitiesPayload(userId) {
  try {
    const raw = await redis.get(communitiesLastGoodCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.communities) ? parsed : null;
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

async function queryCommunitiesListPage(userId, cursorName, cursorId, fetchLimit) {
  return query({
    text: COMMUNITIES_LIST_PAGE_SQL,
    values: [userId, cursorName, cursorId, fetchLimit],
    query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
  });
}

async function fetchUnreadCountsForCommunities(userId, communityIds) {
  if (!communityIds.length) return new Map();
  if (communitiesUnreadQueriesInFlight >= COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT) {
    recordEndpointListCacheBypass('communities', 'pressure');
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
    return new Map(rows.map((row) => [row.community_id, Number(row.unread_channel_count || 0)]));
  } catch (err) {
    if (isCommunitiesTimeout(err)) {
      logger.warn({ err }, 'Communities unread-count query timed out; using unread=0 fallback');
      recordEndpointListCacheBypass('communities', 'timeout');
      return new Map();
    }
    throw err;
  } finally {
    communitiesUnreadQueriesInFlight = Math.max(0, communitiesUnreadQueriesInFlight - 1);
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
  if (!Array.isArray(channels) || !channels.length || !latestByChannel?.size) return;
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
      return { error: 'limit must be an integer from 1 to 100' };
    }
    limit = n;
  }
  let after = null;
  if (rawA !== undefined && String(rawA).length) {
    const s = String(rawA).trim();
    if (!uuidValidate(s)) return { error: 'after must be a UUID' };
    after = s;
  }
  if (after && !limit) return { error: 'after requires limit' };
  return { limit, after };
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  const page = parseCommunitiesPageQuery(req);
  if (page.error) return res.status(400).json({ error: page.error });

  if (page.limit) {
    try {
      const publicVersion = await getPublicCommunitiesVersion();
      const userVersion = await getCommunitiesUserVersion(req.user.id);
      const cacheKey = communitiesPagedCacheKey(
        req.user.id,
        publicVersion,
        userVersion,
        page.limit,
        page.after || '',
      );
      const cached = await getJsonCache(redis, cacheKey);
      if (cached) {
        recordEndpointListCache('communities', 'hit');
        return res.json(cached);
      }

      if (communitiesPagedInflight.has(cacheKey)) {
        recordEndpointListCache('communities', 'coalesced');
        try {
          return res.json(await communitiesPagedInflight.get(cacheKey));
        } catch (err) {
          if (isCommunitiesTransientFailure(err) && !page.after) {
            const stale = await readLastGoodCommunitiesPayload(req.user.id);
            if (stale) {
              recordEndpointListCacheBypass('communities', 'timeout');
              logger.warn(
                { err, userId: req.user.id },
                'GET /communities transient failure during coalesced fetch; serving stale cache',
              );
              return res.json(stale);
            }
          }
          if (isCommunitiesTransientFailure(err)) {
            logger.warn({ err, userId: req.user.id }, 'GET /communities transient failure during coalesced fetch');
            return res
              .status(503)
              .set('Retry-After', '1')
              .json({ error: 'Communities are briefly unavailable; please retry.', requestId: req.id });
          }
          return next(err);
        }
      }

      recordEndpointListCache('communities', 'miss');
      const promise = withDistributedSingleflight({
        redis,
        cacheKey,
        inflight: communitiesPagedInflight,
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
              const error: any = new Error('Invalid after cursor');
              error.statusCode = 400;
              throw error;
            }
            cursorName = curRows[0].name;
            cursorId = curRows[0].id;
          }

          const fetchLimit = page.limit + 1;
          const { rows } = await queryCommunitiesListPage(
            req.user.id,
            cursorName,
            cursorId,
            fetchLimit,
          );

          const hasMore = rows.length > page.limit;
          const slice = hasMore ? rows.slice(0, page.limit) : rows;
          const body: any = await buildCommunitiesListPayload(req.user.id, slice);
          if (hasMore) body.nextAfter = slice[slice.length - 1].id;
          await setJsonCacheWithStale(redis, cacheKey, body, COMMUNITIES_PAGED_CACHE_TTL_SECS, {
            staleMultiplier: 1.25,
            maxStaleTtlSeconds: 240,
          });
          if (!page.after) {
            writeLastGoodCommunitiesPayload(req.user.id, body);
          }
          return body;
        },
      });

      return res.json(await promise);
    } catch (err) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ error: 'Invalid after cursor' });
      }
      if (isCommunitiesTransientFailure(err)) {
        logger.warn({ err, userId: req.user.id }, 'GET /communities (paged) transient failure');
        return res
          .status(503)
          .set('Retry-After', '1')
          .json({ error: 'Communities are briefly unavailable; please retry.', requestId: req.id });
      }
      return next(err);
    }
  }

  const publicVersion = await getPublicCommunitiesVersion();
  const cacheKey = communitiesCacheKey(req.user.id, publicVersion);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      recordEndpointListCache('communities', 'hit');
      return res.json(JSON.parse(cached));
    }
  } catch {
    // cache miss – fall through to DB
  }

  if (communitiesInflight.has(cacheKey)) {
    recordEndpointListCache('communities', 'coalesced');
    try {
      return res.json(await communitiesInflight.get(cacheKey));
    } catch (err) {
      if (isCommunitiesTransientFailure(err)) {
        const stale = await readLastGoodCommunitiesPayload(req.user.id);
        if (stale) {
          recordEndpointListCacheBypass('communities', 'timeout');
          logger.warn(
            { err, userId: req.user.id },
            'GET /communities transient failure during coalesced fetch; serving stale cache',
          );
          return res.json(stale);
        }
        logger.warn({ err, userId: req.user.id }, 'GET /communities transient failure during coalesced fetch');
        return res
          .status(503)
          .set('Retry-After', '1')
          .json({ error: 'Communities are briefly unavailable; please retry.', requestId: req.id });
      }
      return next(err);
    }
  }

  recordEndpointListCache('communities', 'miss');
  const promise: Promise<{ communities: any[] }> = (async () => {
    const { rows } = await queryCommunitiesListFull(req.user.id);
    const payload = await buildCommunitiesListPayload(req.user.id, rows);
    redis.setex(cacheKey, COMMUNITIES_CACHE_TTL_SECS, JSON.stringify(payload)).catch(() => {});
    writeLastGoodCommunitiesPayload(req.user.id, payload);
    return payload;
  })();

  communitiesInflight.set(cacheKey, promise);
  promise.finally(() => communitiesInflight.delete(cacheKey)).catch(() => {});

  try {
    res.json(await promise);
  } catch (err) {
    if (isCommunitiesTransientFailure(err)) {
      const stale = await readLastGoodCommunitiesPayload(req.user.id);
      if (stale) {
        recordEndpointListCacheBypass('communities', 'timeout');
        logger.warn(
          { err, userId: req.user.id },
          'GET /communities transient failure; serving stale cache',
        );
        return res.json(stale);
      }
      logger.warn({ err, userId: req.user.id }, 'GET /communities transient failure');
      return res
        .status(503)
        .set('Retry-After', '1')
        .json({ error: 'Communities are briefly unavailable; please retry.', requestId: req.id });
    }
    next(err);
  }
});

// ── Create ─────────────────────────────────────────────────────────────────────
router.post('/',
  body('slug').isString().custom((value) => value.trim().length > 0),
  body('name').isString().custom((value) => value.trim().length > 0),
  body('description').optional().isString(),
  body('isPublic').optional().isBoolean(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    let client;
    try {
      client = await getClient();
      await client.query('BEGIN');
      const slug = String(req.body.slug).trim();
      const name = String(req.body.name).trim();
      const description = typeof req.body.description === 'string' ? req.body.description : null;
      const { isPublic = true } = req.body;
      const { rowCount } = await client.query(
        'SELECT 1 FROM communities WHERE owner_id = $1',
        [req.user.id]
      );
      if (rowCount >= 100) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Maximum 100 communities reached' });
      }
      const { rows } = await client.query(
        `INSERT INTO communities (slug, name, description, is_public, owner_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${COMMUNITY_RETURNING_FIELDS}`,
        [slug, name, description || null, isPublic, req.user.id]
      );
      const community = rows[0];

      await client.query(
        `INSERT INTO community_members (community_id, user_id, role) VALUES ($1,$2,'owner')`,
        [community.id, req.user.id]
      );
      community.member_count = 1;

      // Create a default #general channel
      await client.query(
        `INSERT INTO channels (community_id, name, created_by) VALUES ($1,'general',$2)`,
        [community.id, req.user.id]
      );

      await client.query('COMMIT');
      await Promise.allSettled([
        presenceService.invalidatePresenceFanoutTargets(req.user.id),
        invalidateWsBootstrapCache(req.user.id),
      ]);
      if (isPublic) {
        await bumpPublicCommunitiesVersion();
      }
      const publicVersion = await getPublicCommunitiesVersion();
      invalidateCommunitiesCaches([req.user.id], publicVersion).catch(() => {});
      // Redundant id fields: harness / generated clients sometimes read `body.id`
      // or `body.communityId` instead of `body.community.id`, producing `/communities//join`.
      res.status(201).json({
        community,
        id: community.id,
        communityId: community.id,
      });
    } catch (err) {
      await client?.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Slug already taken' });
      next(err);
    } finally { client?.release(); }
  }
);

// ── Get ────────────────────────────────────────────────────────────────────────
router.get('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows } = await queryRead(
      `SELECT ${COMMUNITY_SELECT_FIELDS},
              json_agg(
                ${COMMUNITY_DETAIL_CHANNEL_JSON}
              ) FILTER (
                WHERE ch.id IS NOT NULL
                  AND (
                    ch.is_private = FALSE
                    OR EXISTS (
                      SELECT 1 FROM channel_members cm
                      WHERE cm.channel_id = ch.id AND cm.user_id = $2
                    )
                  )
              ) AS channels
       FROM communities c
       LEFT JOIN channels ch ON ch.community_id = c.id
       WHERE c.id = $1
         AND (c.is_public = TRUE OR EXISTS (
               SELECT 1 FROM community_members cm2
               WHERE cm2.community_id = c.id AND cm2.user_id = $2
             ))
       GROUP BY c.id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const community = rows[0];
    const redisCounts = await getCommunityMemberCountsFromRedis([community.id]);
    const redisCount = redisCounts.get(community.id);
    if (redisCount !== undefined) community.member_count = redisCount;
    if (Array.isArray(community.channels) && community.channels.length > 0) {
      const latestByChannel = await getChannelLastMessageMetaMapFromRedis(
        community.channels.map((ch) => ch.id),
        'community_channel',
      );
      applyCommunityChannelLastMessageMetadata(community.channels, latestByChannel);
    }
    res.json({ community });
  } catch (err) { next(err); }
});

// ── Delete ─────────────────────────────────────────────────────────────────────
router.delete('/:id', param('id').isUUID(), loadMembership, async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows: [community] } = await query(
      'SELECT id, owner_id, is_public FROM communities WHERE id=$1',
      [req.params.id]
    );
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.owner_id !== req.user.id || req.membership?.role !== 'owner') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { rows: memberRows } = await query(
      'SELECT user_id FROM community_members WHERE community_id=$1',
      [req.params.id]
    );
    await cleanupCommunityUnreadCounterKeys(req.params.id);

    // FK cascade from messages.channel_id -> channels.id was dropped (migration 023).
    // Delete all channel messages in this community before the community (and its
    // channels via channels.community_id CASCADE) are removed.
    await query(
      'DELETE FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE community_id = $1)',
      [req.params.id],
    );
    await query('DELETE FROM communities WHERE id=$1', [req.params.id]);

    if (community.is_public) {
      await bumpPublicCommunitiesVersion();
    }

    const publicVersion = await getPublicCommunitiesVersion();

    await Promise.allSettled([
      invalidateCommunitiesCaches(memberRows.map((r) => r.user_id), publicVersion),
      redis.del(membersCacheKey(req.params.id)),
      fanout.publish(`community:${req.params.id}`, {
        event: 'community:deleted',
        data: { communityId: req.params.id },
      }),
    ]);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Join ───────────────────────────────────────────────────────────────────────
// Body-based join for harnesses that POST /communities/join with id in JSON (no :id path).
router.post(
  '/join',
  communityJoinIpRateLimiter,
  communityJoinUserRateLimiter,
  async (req, res, next) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const raw = String(
      body.communityId ?? body.community_id ?? body.id ?? body.slug ?? body.name ?? ''
    ).trim();
    if (!raw) {
      return res.status(400).json({ error: 'Missing community id', requestId: req.id });
    }
    try {
      const resolved = await resolveCommunityIdForPublicJoin(raw);
      return executeResolvedPublicJoin(req, res, next, resolved);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/join',
  communityJoinIpRateLimiter,
  communityJoinUserRateLimiter,
  param('id').trim().isLength({ min: 1, max: 512 }),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      const resolved = await resolveCommunityIdForPublicJoin(req.params.id);
      return executeResolvedPublicJoin(req, res, next, resolved);
    } catch (err) { next(err); }
  }
);

// ── Leave ──────────────────────────────────────────────────────────────────────
router.delete('/:id/leave', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rowCount } = await query(
      `DELETE FROM community_members
       WHERE community_id=$1 AND user_id=$2 AND role != 'owner'
       RETURNING user_id`,
      [req.params.id, req.user.id]
    );
    if (!rowCount) {
      return res.json({ success: true });
    }

    decrCommunityMemberCount(req.params.id).catch(() => {});

    const { rows: remainingMembers } = await query(
      'SELECT user_id FROM community_members WHERE community_id=$1',
      [req.params.id]
    );

    await presenceService.invalidatePresenceFanoutTargets(req.user.id);
    invalidateWsBootstrapCache(req.user.id).catch(() => {});
    invalidateWsAclCache(req.user.id, `community:${req.params.id}`);

    const publicVersion = await getPublicCommunitiesVersion();

    const leaveChannelIds = await getCommunityChannelIds(req.params.id);
    evictChannelAccessCacheForUser(redis, leaveChannelIds, req.user.id).catch(() => {});

    await Promise.allSettled([
      invalidateCommunityChannelUserFanoutTargetsCache(req.params.id, leaveChannelIds),
      invalidateCommunitiesCaches(
        [req.user.id, ...remainingMembers.map((member) => member.user_id)],
        publicVersion,
      ),
      redis.del(membersCacheKey(req.params.id)),
      fanout.publish(`community:${req.params.id}`, {
        event: 'community:member_left',
        data: { userId: req.user.id, leftUserId: req.user.id, communityId: req.params.id },
      }),
    ]);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Members + presence ─────────────────────────────────────────────────────────
router.get('/:id/members', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows: accessRows } = await query(
      `SELECT cm.role AS my_role
       FROM communities c
       LEFT JOIN community_members cm
         ON cm.community_id = c.id AND cm.user_id = $2
       WHERE c.id = $1`,
      [req.params.id, req.user.id]
    );
    if (!accessRows.length) return res.status(404).json({ error: 'Community not found' });
    if (!accessRows[0].my_role) {
      return res.status(403).json({ error: 'Not a community member' });
    }

    const rows = await loadCommunityMembersRoster(req.params.id);
    const presenceMap = await presenceService.getBulkPresenceDetails(rows.map(r => r.id));
    const members = rows.map(r => ({
      ...r,
      status: presenceMap[r.id]?.status || 'offline',
      away_message: presenceMap[r.id]?.awayMessage || null,
    }));
    res.json({ members });
  } catch (err) { next(err); }
});

router.patch(
  '/:id/members/:userId',
  param('id').isUUID(),
  param('userId').isUUID(),
  body('role').isIn(['member', 'admin']),
  loadMembership,
  async (req, res, next) => {
    if (!validate(req, res)) return;
    let client;
    try {
      if (req.membership?.role !== 'owner') {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      client = await getClient();
      await client.query('BEGIN');

      const { rows: [community] } = await client.query(
        'SELECT id, owner_id FROM communities WHERE id = $1',
        [req.params.id]
      );
      if (!community) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Community not found' });
      }
      if (community.owner_id === req.params.userId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot change owner role' });
      }

      const { rows } = await client.query(
        `UPDATE community_members
         SET role = $1
         WHERE community_id = $2 AND user_id = $3
         RETURNING community_id, user_id, role`,
        [req.body.role, req.params.id, req.params.userId]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Member not found' });
      }

      await client.query('COMMIT');

      const publicVersion = await getPublicCommunitiesVersion();

      await Promise.allSettled([
        invalidateCommunitiesCaches([req.params.userId], publicVersion),
        redis.del(membersCacheKey(req.params.id)),
        fanout.publish(`community:${req.params.id}`, {
          event: 'community:role_updated',
          data: {
            communityId: req.params.id,
            userId: req.params.userId,
            role: rows[0].role,
          },
        }),
      ]);

      res.json({
        member: {
          community_id: rows[0].community_id,
          user_id: rows[0].user_id,
          role: rows[0].role,
        },
      });
    } catch (err) {
      await client?.query('ROLLBACK');
      next(err);
    } finally {
      client?.release();
    }
  }
);

module.exports = router;
