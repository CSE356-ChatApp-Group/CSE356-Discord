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
const { validate: uuidValidate } = require('uuid');
const { body, param, validationResult } = require('express-validator');

const { query, getClient } = require('../db/pool');
const redis            = require('../db/redis');
const logger           = require('../utils/logger');
const { authenticate } = require('../middleware/authenticate');
const presenceService  = require('../presence/service');
const fanout           = require('../websocket/fanout');
const { invalidateWsBootstrapCache, invalidateWsAclCache } = require('../websocket/server');
const { recordEndpointListCache } = require('../utils/endpointCacheMetrics');

const router = express.Router();
router.use(authenticate);

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ errors: errors.array() }); return false; }
  return true;
}

/** Middleware: load caller's community membership into req.membership */
async function loadMembership(req, res, next) {
  const { rows } = await query(
    'SELECT * FROM community_members WHERE community_id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  req.membership = rows[0] || null;
  next();
}

const _communitiesTtl = parseInt(process.env.COMMUNITIES_LIST_CACHE_TTL_SECS || '300', 10);
const COMMUNITIES_CACHE_TTL_SECS =
  Number.isFinite(_communitiesTtl) && _communitiesTtl > 0 ? _communitiesTtl : 300;
const _communitiesHeavyTimeout = parseInt(process.env.COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS || '2500', 10);
const COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS =
  Number.isFinite(_communitiesHeavyTimeout) && _communitiesHeavyTimeout > 100
    ? _communitiesHeavyTimeout
    : 2500;
const PUBLIC_COMMUNITIES_VERSION_KEY = 'communities:list:public_version';

function communitiesCacheKey(userId, publicVersion = '0') {
  return `communities:list:${userId}:v${publicVersion}`;
}

async function getPublicCommunitiesVersion() {
  return (await redis.get(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => null)) || '0';
}

async function bumpPublicCommunitiesVersion() {
  await redis.incr(PUBLIC_COMMUNITIES_VERSION_KEY).catch(() => {});
}

const MEMBERS_CACHE_TTL_SECS = 30;
function membersCacheKey(communityId) { return `community:${communityId}:members`; }

// In-process singleflight: prevents thundering-herd when cache expires.
// All concurrent requests for the same key share one DB query in flight.
const communitiesInflight: Map<string, Promise<{ communities: any[] }>> = new Map();

async function cleanupCommunityUnreadCounterKeys(communityId) {
  try {
    const { rows } = await query('SELECT id::text FROM channels WHERE community_id = $1', [communityId]);
    if (!rows.length) return;
    const channelKeys = rows.map((row) => `channel:msg_count:${row.id}`);
    await redis.del(...channelKeys);
  } catch {
    // Best-effort cleanup; never block community deletion.
  }
}

/** Shared list body (full list + keyset pages use the same SELECT list). */
const COMMUNITIES_LIST_CORE = `
       WITH visible_communities AS (
         SELECT c.*, cm.role AS my_role
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
       ),
       unread_counts AS (
         SELECT ch.community_id, COUNT(*)::int AS unread_channel_count
         FROM channels ch
         JOIN visible_communities vc ON vc.id = ch.community_id
         LEFT JOIN channel_members chm
           ON chm.channel_id = ch.id
          AND chm.user_id = $1
         LEFT JOIN read_states rs
           ON rs.channel_id = ch.id
          AND rs.user_id = $1
         WHERE (ch.is_private = FALSE OR chm.user_id IS NOT NULL)
           AND ch.last_message_id IS NOT NULL
           AND ch.last_message_author_id IS DISTINCT FROM $1
           AND rs.last_read_message_id IS DISTINCT FROM ch.last_message_id
         GROUP BY ch.community_id
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
              COALESCE(mc.member_count, 0) AS member_count,
              COALESCE(uc.unread_channel_count, 0) AS unread_channel_count,
              (COALESCE(uc.unread_channel_count, 0) > 0) AS has_unread_channels
       FROM visible_communities vc
       LEFT JOIN member_counts mc ON mc.community_id = vc.id
       LEFT JOIN unread_counts uc ON uc.community_id = vc.id`;

// Fallback used when the heavy unread-count query times out under burst load.
// Keeps the route available with member_count while setting unread fields to 0.
const COMMUNITIES_LIST_FALLBACK_CORE = `
       WITH visible_communities AS (
         SELECT c.*, cm.role AS my_role
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
              COALESCE(mc.member_count, 0) AS member_count,
              0::int AS unread_channel_count,
              FALSE AS has_unread_channels
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

async function queryCommunitiesListWithFallback(baseSql, params, orderAndLimitSql) {
  const fullSql = `${baseSql}
       ${orderAndLimitSql}`;
  try {
    return await query({
      text: fullSql,
      values: params,
      // Keep communities list responsive under burst; fallback omits unread scan.
      query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
    });
  } catch (err) {
    if (!isCommunitiesTimeout(err)) throw err;
    logger.warn({ err }, 'Communities heavy query timed out; using fallback');
    const fallbackSql = `${COMMUNITIES_LIST_FALLBACK_CORE}
       ${orderAndLimitSql}`;
    return query({
      text: fallbackSql,
      values: params,
      query_timeout: COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS,
    });
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
      let cursorName = null;
      let cursorId = null;
      if (page.after) {
        const { rows: curRows } = await query(
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
        if (!curRows.length) return res.status(400).json({ error: 'Invalid after cursor' });
        cursorName = curRows[0].name;
        cursorId = curRows[0].id;
      }

      const fetchLimit = page.limit + 1;
      const { rows } = await queryCommunitiesListWithFallback(
        COMMUNITIES_LIST_CORE,
        [req.user.id, cursorName, cursorId, fetchLimit],
        `WHERE (($2::text IS NULL AND $3::uuid IS NULL) OR (vc.name, vc.id) > ($2::text, $3::uuid))
       ORDER BY vc.name, vc.id
       LIMIT $4`,
      );

      const hasMore = rows.length > page.limit;
      const slice = hasMore ? rows.slice(0, page.limit) : rows;
      const body: any = { communities: slice };
      if (hasMore) body.nextAfter = slice[slice.length - 1].id;
      return res.json(body);
    } catch (err) {
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
      return next(err);
    }
  }

  recordEndpointListCache('communities', 'miss');
  const promise: Promise<{ communities: any[] }> = (async () => {
    const { rows } = await queryCommunitiesListWithFallback(
      COMMUNITIES_LIST_CORE,
      [req.user.id],
      `ORDER BY vc.name, vc.id`,
    );
    const payload = { communities: rows };
    redis.setex(cacheKey, COMMUNITIES_CACHE_TTL_SECS, JSON.stringify(payload)).catch(() => {});
    return payload;
  })();

  communitiesInflight.set(cacheKey, promise);
  promise.finally(() => communitiesInflight.delete(cacheKey));

  try {
    res.json(await promise);
  } catch (err) {
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
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
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
      redis.del(communitiesCacheKey(req.user.id, publicVersion)).catch(() => {});
      res.status(201).json({ community });
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
    const { rows } = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
              json_agg(
                ch.* ORDER BY ch.position
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

    await query('DELETE FROM communities WHERE id=$1', [req.params.id]);

    if (community.is_public) {
      await bumpPublicCommunitiesVersion();
    }

    const publicVersion = await getPublicCommunitiesVersion();

    await Promise.allSettled([
      ...memberRows.map((r) => redis.del(communitiesCacheKey(r.user_id, publicVersion))),
      fanout.publish(`community:${req.params.id}`, {
        event: 'community:deleted',
        data: { communityId: req.params.id },
      }),
    ]);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Join ───────────────────────────────────────────────────────────────────────
router.post('/:id/join', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows: [community] } = await query(
      'SELECT * FROM communities WHERE id=$1', [req.params.id]
    );
    if (!community) return res.status(404).json({ error: 'Community not found' });

    if (!community.is_public) {
      return res.status(403).json({ error: 'Community is private' });
    }

    await query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    await Promise.allSettled([
      presenceService.invalidatePresenceFanoutTargets(req.user.id),
      invalidateWsBootstrapCache(req.user.id),
    ]);
    invalidateWsAclCache(req.user.id, `community:${req.params.id}`);
    {
      const publicVersion = await getPublicCommunitiesVersion();
      redis.del(communitiesCacheKey(req.user.id, publicVersion)).catch(() => {});
    }
    redis.del(membersCacheKey(req.params.id)).catch(() => {});

    await fanout.publish(`community:${req.params.id}`, {
      event: 'community:member_joined',
      data: { userId: req.user.id, communityId: req.params.id },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

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
      redis.del(communitiesCacheKey(req.user.id, publicVersion)),
      redis.del(membersCacheKey(req.params.id)),
      ...remainingMembers.map((member) => redis.del(communitiesCacheKey(member.user_id, publicVersion))),
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

    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role, cm.joined_at
       FROM community_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.community_id = $1
       ORDER BY cm.role DESC, u.username`,
      [req.params.id]
    );
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
        redis.del(communitiesCacheKey(req.params.userId, publicVersion)),
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
