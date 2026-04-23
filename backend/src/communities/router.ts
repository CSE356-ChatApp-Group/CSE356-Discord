/**
 * Communities routes
 *
 * GET    /api/v1/communities                    – list public + joined (optional ?limit=&after= for paging)
 * POST   /api/v1/communities                    – create
 * GET    /api/v1/communities/:id                – get details
 * DELETE /api/v1/communities/:id                – delete (owner only)
 * PATCH  /api/v1/communities/:id                – update (admin+)
 * POST   /api/v1/communities/:id/join           – join public community
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
const { invalidateCommunityChannelUserFanoutTargetsCache } = require('../messages/channelRealtimeFanout');
const { recordEndpointListCache, recordEndpointListCacheBypass } = require('../utils/endpointCacheMetrics');
const { apiRateLimitHitsTotal } = require('../utils/metrics');
const { recordAbuseStrikeFromRequest } = require('../utils/autoIpBan');
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
} = require('../utils/distributedSingleflight');

const router = express.Router();
router.use(authenticate);

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ errors: errors.array() }); return false; }
  return true;
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

const COMMUNITY_RETURNING_FIELDS = `
  id,
  slug,
  name,
  description,
  icon_url,
  owner_id,
  is_public,
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
    normalizedUserIds.map((userId) => redis.incr(communitiesUserVersionKey(userId))),
  );
}

async function getPublicCommunitiesVersion() {
  return (await redis.get(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => null)) || '0';
}

async function bumpPublicCommunitiesVersion() {
  await redis.incr(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => {});
}

async function getCommunitiesUserVersion(userId) {
  return (await redis.get(communitiesUserVersionKey(userId)).catch(() => null)) || '0';
}

const MEMBERS_CACHE_TTL_SECS = 30;
function membersCacheKey(communityId) { return `community:${communityId}:members`; }

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
// All concurrent requests for the same key share one DB query in flight.
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

/** Shared list body (full list + keyset pages use the same SELECT list). */
const COMMUNITIES_LIST_BASE_CORE = `
       WITH visible_communities AS (
         SELECT c.id,
                c.slug,
                c.name,
                c.description,
                c.icon_url,
                c.is_public,
                c.owner_id,
                c.created_at,
                c.updated_at,
                cm.role AS my_role
         FROM communities c
         LEFT JOIN community_members cm
           ON cm.community_id = c.id
          AND cm.user_id = $1
         WHERE c.is_public = TRUE OR cm.user_id IS NOT NULL
       ),
       member_counts AS (
         SELECT cm.community_id, COUNT(*)::int AS member_count
         FROM community_members cm
         JOIN visible_communities vc ON vc.id = cm.community_id
         GROUP BY cm.community_id
       )
       SELECT vc.id,
              vc.slug,
              vc.name,
              vc.description,
              vc.icon_url,
              vc.is_public,
              vc.owner_id,
              vc.created_at,
              vc.updated_at,
              vc.my_role,
              COALESCE(mc.member_count, 0) AS member_count
       FROM visible_communities vc
       LEFT JOIN member_counts mc ON mc.community_id = vc.id`;

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

async function queryCommunitiesListBase(baseSql, params, orderAndLimitSql) {
  const fullSql = `${baseSql}
       ${orderAndLimitSql}`;
  return queryRead({
    text: fullSql,
    values: params,
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
  const unreadByCommunity = await fetchUnreadCountsForCommunities(
    userId,
    rows.map((row) => row.id),
  );
  return {
    communities: rows.map((row) => {
      const unread = unreadByCommunity.get(row.id) || 0;
      return {
        ...row,
        unread_channel_count: unread,
        has_unread_channels: unread > 0,
      };
    }),
  };
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
        return res.json(await communitiesPagedInflight.get(cacheKey));
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
              `WITH visible_communities AS (
                 SELECT c.id, c.name
                 FROM communities c
                 LEFT JOIN community_members cm
                   ON cm.community_id = c.id AND cm.user_id = $1
                 WHERE c.is_public = TRUE OR cm.user_id IS NOT NULL
               )
               SELECT name, id FROM visible_communities WHERE id = $2`,
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
          const { rows } = await queryCommunitiesListBase(
            COMMUNITIES_LIST_BASE_CORE,
            [req.user.id, cursorName, cursorId, fetchLimit],
            `WHERE (($2::text IS NULL AND $3::uuid IS NULL) OR (vc.name, vc.id) > ($2::text, $3::uuid))
           ORDER BY vc.name, vc.id
           LIMIT $4`,
          );

          const hasMore = rows.length > page.limit;
          const slice = hasMore ? rows.slice(0, page.limit) : rows;
          const body: any = await buildCommunitiesListPayload(req.user.id, slice);
          if (hasMore) body.nextAfter = slice[slice.length - 1].id;
          await setJsonCacheWithStale(redis, cacheKey, body, COMMUNITIES_PAGED_CACHE_TTL_SECS);
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

  // Singleflight: if a DB query is already in-flight for this key, wait for it
  // rather than spawning a second concurrent query (thundering-herd defence).
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
    const { rows } = await queryCommunitiesListBase(
      COMMUNITIES_LIST_BASE_CORE,
      [req.user.id],
      `ORDER BY vc.name, vc.id`,
    );
    const payload = await buildCommunitiesListPayload(req.user.id, rows);
    redis.setex(cacheKey, COMMUNITIES_CACHE_TTL_SECS, JSON.stringify(payload)).catch(() => {});
    writeLastGoodCommunitiesPayload(req.user.id, payload);
    return payload;
  })();

  communitiesInflight.set(cacheKey, promise);
  // Avoid unhandledRejection when the shared in-flight query rejects: .finally()
  // returns a new promise that mirrors rejection unless we attach a handler.
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
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
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
    res.json({ community: rows[0] });
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
router.post(
  '/:id/join',
  communityJoinIpRateLimiter,
  communityJoinUserRateLimiter,
  param('id').isUUID(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    try {
      const { rows: [community] } = await query(
        'SELECT id, is_public FROM communities WHERE id=$1', [req.params.id]
      );
      if (!community) return res.status(404).json({ error: 'Community not found' });

      if (!community.is_public) {
        return res.status(403).json({ error: 'Community is private' });
      }

      const { rowCount } = await query(
        `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.id, req.user.id]
      );
      if (!rowCount) {
        return res.json({ success: true });
      }

      const realtimeTargets = await listCommunityRealtimeTargets(req.params.id, req.user.id);
      await Promise.allSettled([
        invalidateCommunityChannelUserFanoutTargetsCache(req.params.id),
        presenceService.invalidatePresenceFanoutTargets(req.user.id),
        invalidateWsBootstrapCache(req.user.id),
        publishUserFeedTargets([req.user.id], {
          __wsInternal: {
            kind: 'subscribe_channels',
            channels: realtimeTargets,
          },
        }),
      ]);
      invalidateWsAclCache(req.user.id, `community:${req.params.id}`);
      {
        const publicVersion = await getPublicCommunitiesVersion();
        invalidateCommunitiesCaches([req.user.id], publicVersion).catch(() => {});
      }
      redis.del(membersCacheKey(req.params.id)).catch(() => {});

      await fanout.publish(`community:${req.params.id}`, {
        event: 'community:member_joined',
        data: { userId: req.user.id, communityId: req.params.id },
      });

      res.json({ success: true });
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

    const { rows: remainingMembers } = await query(
      'SELECT user_id FROM community_members WHERE community_id=$1',
      [req.params.id]
    );

    await presenceService.invalidatePresenceFanoutTargets(req.user.id);
    invalidateWsBootstrapCache(req.user.id).catch(() => {});
    invalidateWsAclCache(req.user.id, `community:${req.params.id}`);

    const publicVersion = await getPublicCommunitiesVersion();

    await Promise.allSettled([
      invalidateCommunityChannelUserFanoutTargetsCache(req.params.id),
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
    // One round-trip for community existence + caller membership (replaces loadMembership + EXISTS).
    const { rows: accessRows } = await queryRead(
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

    const cacheKey = membersCacheKey(req.params.id);
    const cachedRoster = await redis.get(cacheKey);
    let rows;
    if (cachedRoster) {
      rows = JSON.parse(cachedRoster);
    } else {
      ({ rows } = await queryRead(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role, cm.joined_at
         FROM community_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.community_id = $1
         ORDER BY cm.role DESC, u.username`,
        [req.params.id]
      ));
      redis.setex(cacheKey, MEMBERS_CACHE_TTL_SECS, JSON.stringify(rows)).catch(() => {});
    }
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
