/**
 * Users routes
 *
 * GET   /api/v1/users/me         – own profile
 * PATCH /api/v1/users/me         – update profile
 * GET   /api/v1/users/:id        – public profile
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const presenceService  = require('../presence/service');

const router = express.Router();
router.use(authenticate);

const PUBLIC_FIELDS = 'id, username, display_name, avatar_url, bio, created_at, last_seen_at';

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${PUBLIC_FIELDS}, email FROM users WHERE id=$1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const status = await presenceService.getPresence(req.user.id);
    res.json({ user: { ...rows[0], status } });
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
      const updates = {};
      if (req.body.displayName) updates.display_name = req.body.displayName;
      if (req.body.bio !== undefined) updates.bio = req.body.bio;
      if (req.body.password) updates.password_hash = await bcrypt.hash(req.body.password, 12);

      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

      const setClauses = Object.keys(updates).map((k, i) => `${k}=$${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE users SET ${setClauses}, updated_at=NOW() WHERE id=$1 RETURNING ${PUBLIC_FIELDS}, email`,
        [req.user.id, ...Object.values(updates)]
      );
      res.json({ user: rows[0] });
    } catch (err) { next(err); }
  }
);

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const status = await presenceService.getPresence(req.params.id);
    res.json({ user: { ...rows[0], status } });
  } catch (err) { next(err); }
});

module.exports = router;
