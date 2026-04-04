/**
 * Users routes
 *
 * GET   /api/v1/users              – search users by ?q=
 * GET   /api/v1/users/me           – own profile
 * PATCH /api/v1/users/me           – update profile
 * POST  /api/v1/users/me/avatar    – upload avatar image
 * GET   /api/v1/users/:id          – public profile
 * GET   /api/v1/users/:id/avatar   – serve avatar image
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const { hashPassword } = require('./passwords');
const presenceService  = require('../presence/service');

const router = express.Router();

const PUBLIC_FIELDS = 'id, username, display_name, avatar_url, bio, created_at, last_seen_at';

// multer in-memory, 5 MB max, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── Search users (no auth required, returns public fields) ─────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt((req.query.limit || '25').toString(), 10) || 25, 100);
    if (!q) {
      return res.status(400).json({ error: 'q query param required' });
    }
    const pattern = `%${q}%`;
    const { rows } = await query(
      `SELECT ${PUBLIC_FIELDS}
       FROM   users
       WHERE  is_active = TRUE
         AND  (username ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1)
       ORDER  BY username
       LIMIT  $2`,
      [pattern, limit]
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

// ── Serve avatar image (public — browsers cannot send Authorization via <img>) ──
router.get('/:id/avatar', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT avatar_data, avatar_content_type FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length || !rows[0].avatar_data) {
      return res.status(404).json({ error: 'No avatar' });
    }
    res.setHeader('Content-Type', rows[0].avatar_content_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(rows[0].avatar_data);
  } catch (err) { next(err); }
});

router.use(authenticate);

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { status, awayMessage } = await presenceService.getPresenceDetails(req.user.id);
    res.json({ user: { ...rows[0], status, away_message: awayMessage } });
  } catch (err) { next(err); }
});

router.patch('/me',
  body('displayName').optional().isLength({ min: 1, max: 64 }),
  body('bio').optional().isLength({ max: 500 }),
  body('password').optional().isLength({ min: 8 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const updates: Record<string, unknown> = {};
      if (req.body.displayName) updates.display_name = req.body.displayName;
      if (req.body.bio !== undefined) updates.bio = req.body.bio;
      if (req.body.password) updates.password_hash = await hashPassword(req.body.password, 'user_update_hash');

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

      const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
      const { rows } = await query(
        `UPDATE users SET ${setClauses}, updated_at=NOW() WHERE id=$1 RETURNING ${PUBLIC_FIELDS}, email`,
        [req.user.id, ...Object.values(updates)]
      );
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Avatar upload ──────────────────────────────────────────────────────────────
router.post('/me/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided (field: avatar)' });
    const avatarUrl = `/api/v1/users/${req.user.id}/avatar`;
    await query(
      `UPDATE users SET avatar_url=$2, avatar_data=$3, avatar_content_type=$4, updated_at=NOW() WHERE id=$1`,
      [req.user.id, avatarUrl, req.file.buffer, req.file.mimetype]
    );
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [req.user.id]);
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

// Also accept PUT for compatibility
router.put('/me/avatar', upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided (field: avatar)' });
    const avatarUrl = `/api/v1/users/${req.user.id}/avatar`;
    await query(
      `UPDATE users SET avatar_url=$2, avatar_data=$3, avatar_content_type=$4, updated_at=NOW() WHERE id=$1`,
      [req.user.id, avatarUrl, req.file.buffer, req.file.mimetype]
    );
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [req.user.id]);
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

// ── Serve avatar image ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    // Include email so clients can map SSO usernames
    const { rows } = await query(
      `SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { status, awayMessage } = await presenceService.getPresenceDetails(req.params.id);
    res.json({ user: { ...rows[0], status, away_message: awayMessage } });
  } catch (err) { next(err); }
});

module.exports = router;
