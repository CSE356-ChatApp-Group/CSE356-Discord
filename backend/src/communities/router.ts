/**
 * Communities routes
 *
 * GET    /api/v1/communities                    – list public + joined
 * POST   /api/v1/communities                    – create
 * GET    /api/v1/communities/:id                – get details
 * DELETE /api/v1/communities/:id                – delete (owner only)
 * PATCH  /api/v1/communities/:id                – update (admin+)
 * POST   /api/v1/communities/:id/join           – join public community
 * DELETE /api/v1/communities/:id/leave          – leave
 * GET    /api/v1/communities/:id/members        – list members + presence
 */

'use strict';

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const presenceService  = require('../presence/service');
const fanout           = require('../websocket/fanout');

const router = express.Router();
router.use(authenticate);

function validate(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { res.status(400).json({ errors: errors.array() }); return false; }
  return true;
}

/** Middleware: load caller's community membership into req.membership */
async function loadMembership(req, res, next) {
  const { rows } = await pool.query(
    'SELECT * FROM community_members WHERE community_id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  req.membership = rows[0] || null;
  next();
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `WITH visible_communities AS (
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
       visible_channels AS (
         SELECT ch.id, ch.community_id
         FROM channels ch
         JOIN visible_communities vc ON vc.id = ch.community_id
         WHERE ch.is_private = FALSE
            OR EXISTS (
              SELECT 1
              FROM channel_members chm
              WHERE chm.channel_id = ch.id
                AND chm.user_id = $1
            )
       ),
       latest_messages AS (
         SELECT DISTINCT ON (m.channel_id)
                m.channel_id,
                m.id,
                m.author_id
         FROM messages m
         JOIN visible_channels ch ON ch.id = m.channel_id
         WHERE m.deleted_at IS NULL
         ORDER BY m.channel_id, m.created_at DESC
       ),
       unread_counts AS (
         SELECT ch.community_id, COUNT(*)::int AS unread_channel_count
         FROM visible_channels ch
         JOIN latest_messages lm ON lm.channel_id = ch.id
         LEFT JOIN read_states rs
           ON rs.channel_id = ch.id
          AND rs.user_id = $1
         WHERE lm.author_id <> $1
           AND rs.last_read_message_id IS DISTINCT FROM lm.id
         GROUP BY ch.community_id
       )
       SELECT vc.*,
              COALESCE(mc.member_count, 0) AS member_count,
              COALESCE(uc.unread_channel_count, 0) AS unread_channel_count,
              (COALESCE(uc.unread_channel_count, 0) > 0) AS has_unread_channels
       FROM visible_communities vc
       LEFT JOIN member_counts mc ON mc.community_id = vc.id
       LEFT JOIN unread_counts uc ON uc.community_id = vc.id
       ORDER BY vc.name`,
      [req.user.id]
    );
    res.json({ communities: rows });
  } catch (err) { next(err); }
});

// ── Create ─────────────────────────────────────────────────────────────────────
router.post('/',
  body('slug').isSlug().isLength({ min: 2, max: 32 }),
  body('name').isString().isLength({ min: 1, max: 100 }),
  body('description').optional().isLength({ max: 500 }),
  body('isPublic').optional().isBoolean(),
  async (req, res, next) => {
    if (!validate(req, res)) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { slug, name, description, isPublic = true } = req.body;
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
      await presenceService.invalidatePresenceFanoutTargets(req.user.id);
      res.status(201).json({ community });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Slug already taken' });
      next(err);
    } finally { client.release(); }
  }
);

// ── Get ────────────────────────────────────────────────────────────────────────
router.get('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS member_count,
              json_agg(ch.* ORDER BY ch.position) FILTER (WHERE ch.id IS NOT NULL) AS channels
       FROM communities c
       LEFT JOIN channels ch ON ch.community_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ community: rows[0] });
  } catch (err) { next(err); }
});

// ── Delete ─────────────────────────────────────────────────────────────────────
router.delete('/:id', param('id').isUUID(), loadMembership, async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows: [community] } = await pool.query(
      'SELECT id, owner_id FROM communities WHERE id=$1',
      [req.params.id]
    );
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.owner_id !== req.user.id || req.membership?.role !== 'owner') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await pool.query('DELETE FROM communities WHERE id=$1', [req.params.id]);

    await fanout.publish(`community:${req.params.id}`, {
      event: 'community:deleted',
      data: { communityId: req.params.id },
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Join ───────────────────────────────────────────────────────────────────────
router.post('/:id/join', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows: [community] } = await pool.query(
      'SELECT * FROM communities WHERE id=$1', [req.params.id]
    );
    if (!community) return res.status(404).json({ error: 'Community not found' });

    if (!community.is_public) {
      return res.status(403).json({ error: 'Community is private' });
    }

    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    await presenceService.invalidatePresenceFanoutTargets(req.user.id);

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
    await pool.query(
      `DELETE FROM community_members WHERE community_id=$1 AND user_id=$2 AND role != 'owner'`,
      [req.params.id, req.user.id]
    );
    await presenceService.invalidatePresenceFanoutTargets(req.user.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Members + presence ─────────────────────────────────────────────────────────
router.get('/:id/members', param('id').isUUID(), async (req, res, next) => {
  if (!validate(req, res)) return;
  try {
    const { rows } = await pool.query(
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

module.exports = router;
