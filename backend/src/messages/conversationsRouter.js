/**
 * Conversations router (direct messages)
 *
 * GET  /api/v1/conversations          – list user's conversations
 * POST /api/v1/conversations          – create/get 1:1 or group DM
 * GET  /api/v1/conversations/:id      – get single conversation
 */

'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();
router.use(authenticate);

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              json_agg(json_build_object('id',u.id,'username',u.username,'displayName',u.display_name,'avatarUrl',u.avatar_url))
                AS participants
       FROM   conversations c
       JOIN   conversation_participants cp ON cp.conversation_id = c.id
       JOIN   conversation_participants cp2 ON cp2.conversation_id = c.id
       JOIN   users u ON u.id = cp2.user_id
       WHERE  cp.user_id = $1 AND cp.left_at IS NULL
       GROUP  BY c.id
       ORDER  BY c.updated_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: rows });
  } catch (err) { next(err); }
});

// ── Create or get existing 1:1 ─────────────────────────────────────────────────
router.post('/',
  body('participantIds').isArray({ min: 1, max: 9 }),
  body('name').optional().isLength({ max: 100 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const allIds = [...new Set([req.user.id, ...req.body.participantIds])];
      const isGroup = allIds.length > 2;

      // For 1:1, check if conversation already exists
      if (!isGroup) {
        const otherId = allIds.find(id => id !== req.user.id);
        const { rows } = await client.query(
          `SELECT c.* FROM conversations c
           JOIN conversation_participants cp1 ON cp1.conversation_id = c.id AND cp1.user_id = $1
           JOIN conversation_participants cp2 ON cp2.conversation_id = c.id AND cp2.user_id = $2
           WHERE c.name IS NULL
           LIMIT 1`,
          [req.user.id, otherId]
        );
        if (rows.length) {
          await client.query('COMMIT');
          return res.json({ conversation: rows[0], created: false });
        }
      }

      const { rows: [conv] } = await client.query(
        `INSERT INTO conversations (name, created_by) VALUES ($1,$2) RETURNING *`,
        [req.body.name || null, req.user.id]
      );

      for (const uid of allIds) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1,$2)`,
          [conv.id, uid]
        );
      }

      await client.query('COMMIT');
      res.status(201).json({ conversation: conv, created: true });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally { client.release(); }
  }
);

// ── Get single ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
              json_agg(json_build_object('id',u.id,'username',u.username,'displayName',u.display_name))
                AS participants
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
       JOIN users u ON u.id = cp.user_id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ conversation: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
