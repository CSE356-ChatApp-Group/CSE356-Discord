/**
 * Channels router
 *
 * GET    /api/v1/channels?communityId=         – list accessible channels
 * POST   /api/v1/channels                      – create channel
 * PATCH  /api/v1/channels/:id                  – update
 * DELETE /api/v1/channels/:id                  – delete
 */

'use strict';

const express = require('express');
const { body, query: qv, param, validationResult } = require('express-validator');
const { pool }         = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const sideEffects      = require('../messages/sideEffects');

const router = express.Router();
router.use(authenticate);

function v(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return false; }
  return true;
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/',
  qv('communityId').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    try {
      // Return accessible channels with last-message/read-pointer metadata.
      const { rows } = await pool.query(
        `SELECT ch.*,
                lm.id AS last_message_id,
                lm.author_id AS last_message_author_id,
                lm.created_at AS last_message_at,
                rs.last_read_message_id AS my_last_read_message_id,
                rs.last_read_at AS my_last_read_at
         FROM   channels ch
         LEFT JOIN LATERAL (
           SELECT m.id, m.author_id, m.created_at
           FROM messages m
           WHERE m.channel_id = ch.id AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) lm ON TRUE
         LEFT JOIN read_states rs
                ON rs.channel_id = ch.id
               AND rs.user_id = $2
         WHERE  ch.community_id = $1
           AND  (ch.is_private = FALSE
                 OR EXISTS (
                   SELECT 1 FROM channel_members cm
                   WHERE cm.channel_id = ch.id AND cm.user_id = $2
                 ))
         ORDER  BY ch.position, ch.name`,
        [req.query.communityId, req.user.id]
      );
      res.json({ channels: rows });
    } catch (err) { next(err); }
  }
);

// ── Create ─────────────────────────────────────────────────────────────────────
router.post('/',
  body('communityId').isUUID(),
  body('name').isString().isLength({ min: 1, max: 100 }),
  body('isPrivate').optional().isBoolean(),
  body('description').optional().isLength({ max: 500 }),
  async (req, res, next) => {
    if (!v(req, res)) return;
    const client = await pool.connect();
    try {
      const { communityId, name, isPrivate = false, description } = req.body;

      // Verify caller is admin+ in the community
      const { rows: [m] } = await client.query(
        `SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2`,
        [communityId, req.user.id]
      );
      if (!m || !['owner','admin','moderator'].includes(m.role)) {
        client.release();
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO channels (community_id, name, is_private, description, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [communityId, name.toLowerCase().replace(/\s+/g, '-'), isPrivate, description || null, req.user.id]
      );
      const channel = rows[0];

      if (isPrivate) {
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           VALUES ($1,$2)
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channel.id, req.user.id]
        );
      }

      await client.query('COMMIT');
      client.release();
      sideEffects.publishMessageEvent(`community:${communityId}`, 'channel:created', channel);
      res.status(201).json({ channel });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failures and surface original error.
      }
      client.release();
      if (err.code === '23505') return res.status(409).json({ error: 'Channel name already exists' });
      next(err);
    }
  }
);

// ── Update ─────────────────────────────────────────────────────────────────────
router.patch('/:id',
  param('id').isUUID(),
  body('name').optional().isString().isLength({ min: 1, max: 100 }),
  body('description').optional().isLength({ max: 500 }),
  async (req, res, next) => {
    if (!v(req, res)) return;
    try {
      const { rows } = await pool.query(
        `UPDATE channels SET name=COALESCE($1,name), description=COALESCE($2,description), updated_at=NOW()
         WHERE id=$3 RETURNING *`,
        [req.body.name || null, req.body.description ?? null, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ channel: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Delete ─────────────────────────────────────────────────────────────────────
router.delete('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!v(req, res)) return;
  try {
    await pool.query('DELETE FROM channels WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
