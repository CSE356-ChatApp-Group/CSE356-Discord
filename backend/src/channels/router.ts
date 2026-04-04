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
const redis            = require('../db/redis');
const logger           = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

function v(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return false; }
  return true;
}

async function loadChannelContext(channelId, userId) {
  const { rows } = await pool.query(
    `SELECT ch.id,
            ch.community_id,
            ch.is_private,
            cm.role AS community_role,
            EXISTS (
              SELECT 1
              FROM channel_members chm
              WHERE chm.channel_id = ch.id AND chm.user_id = $2
            ) AS is_channel_member
     FROM channels ch
     LEFT JOIN community_members cm
       ON cm.community_id = ch.community_id
      AND cm.user_id = $2
     WHERE ch.id = $1`,
    [channelId, userId]
  );
  return rows[0] || null;
}

function canManagePrivateMembership(role) {
  return ['owner', 'admin', 'moderator'].includes(role);
}

/**
 * Bust channels:list cache for every member of a community.
 * Fire-and-forget — runs after the response has been sent.
 */
async function bustChannelListCache(communityId) {
  try {
    const { rows } = await pool.query(
      'SELECT user_id::text FROM community_members WHERE community_id = $1',
      [communityId]
    );
    if (!rows.length) return;
    const keys = rows.map(r => `channels:list:${communityId}:${r.user_id}`);
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err }, 'channels:list cache bust failed');
  }
}

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/',
  qv('communityId').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    const { communityId } = req.query;
    const userId = req.user.id;
    try {
      // Serve from Redis cache when warm (TTL 15 s).  Channel structure changes
      // are rare admin operations; WS events keep the frontend state current.
      const cacheKey = `channels:list:${communityId}:${userId}`;
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      const { rows: membership } = await pool.query(
        `SELECT 1
         FROM community_members
         WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId]
      );
      if (!membership.length) {
        return res.status(403).json({ error: 'Not a community member' });
      }

      // Return all visible channel names. Private-channel metadata/content pointers
      // are redacted for users who are not invited to that private channel.
      const { rows } = await pool.query(
        `WITH visible_channels AS (
           SELECT ch.*,
                  (ch.is_private = FALSE
                   OR EXISTS (
                     SELECT 1 FROM channel_members cm
                     WHERE cm.channel_id = ch.id AND cm.user_id = $2
                   )) AS can_access
           FROM channels ch
           WHERE ch.community_id = $1
         )
         SELECT vc.*,
                vc.can_access,
                CASE WHEN vc.can_access THEN lm.id ELSE NULL END AS last_message_id,
                CASE WHEN vc.can_access THEN lm.author_id ELSE NULL END AS last_message_author_id,
                CASE WHEN vc.can_access THEN lm.created_at ELSE NULL END AS last_message_at,
                CASE WHEN vc.can_access THEN rs.last_read_message_id ELSE NULL END AS my_last_read_message_id,
                CASE WHEN vc.can_access THEN rs.last_read_at ELSE NULL END AS my_last_read_at
         FROM   visible_channels vc
         LEFT JOIN LATERAL (
           SELECT m.id, m.author_id, m.created_at
           FROM messages m
           WHERE m.channel_id = vc.id AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC
           LIMIT 1
         ) lm ON vc.can_access
         LEFT JOIN read_states rs
                ON vc.can_access
               AND rs.channel_id = vc.id
               AND rs.user_id = $2
         ORDER  BY vc.position, vc.name`,
        [communityId, userId]
      );

      // Attach Redis-backed unread_message_count to each accessible channel
      const accessibleRows = rows.filter(ch => ch.can_access);
      if (accessibleRows.length > 0) {
        try {
          // Fetch both keys for all channels in one pipeline
          const pipeline = redis.pipeline();
          for (const ch of accessibleRows) {
            pipeline.get(`channel:msg_count:${ch.id}`);
            pipeline.get(`user:last_read_count:${ch.id}:${userId}`);
          }
          const results = await pipeline.exec();

          // results is array of [err, value] pairs, two per channel
          const missingChannels = [];
          for (let i = 0; i < accessibleRows.length; i++) {
            const ch = accessibleRows[i];
            const [errCount, rawCount] = results[i * 2];
            const [errRead, rawRead]   = results[i * 2 + 1];
            if (errCount || errRead || rawCount === null || rawRead === null) {
              missingChannels.push(ch);
            } else {
              ch.unread_message_count = Math.max(0, parseInt(rawCount, 10) - parseInt(rawRead, 10));
            }
          }

          // For channels missing Redis data: initialize via a single batched
          // SQL query instead of N×2 individual pool checkouts.
          if (missingChannels.length > 0) {
            const channelIds   = missingChannels.map(ch => ch.id);
            const lastReadAts  = missingChannels.map(ch => ch.my_last_read_at || null);

            const { rows: countRows } = await pool.query(
              `SELECT
                 refs.channel_id::text,
                 COUNT(*) FILTER (WHERE m.deleted_at IS NULL)                                                     AS total_count,
                 COUNT(*) FILTER (WHERE m.deleted_at IS NULL
                                    AND (refs.last_read_at IS NULL OR m.created_at <= refs.last_read_at)) AS read_count
               FROM (SELECT unnest($1::uuid[]) AS channel_id,
                            unnest($2::timestamptz[]) AS last_read_at) AS refs
               LEFT JOIN messages m ON m.channel_id = refs.channel_id
               GROUP BY refs.channel_id`,
              [channelIds, lastReadAts]
            );

            const countMap = new Map<string, { total: number; read: number }>(
              countRows.map(r => [r.channel_id, { total: parseInt(r.total_count, 10), read: parseInt(r.read_count, 10) }])
            );

            const initPipeline = redis.pipeline();
            for (const ch of missingChannels) {
              const counts = countMap.get(ch.id) || { total: 0, read: 0 };
              initPipeline.set(`channel:msg_count:${ch.id}`, counts.total, 'NX');
              initPipeline.set(`user:last_read_count:${ch.id}:${userId}`, counts.read, 'NX');
              ch.unread_message_count = Math.max(0, counts.total - counts.read);
            }
            await initPipeline.exec();
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to fetch unread counts from Redis; defaulting to 0');
          for (const ch of accessibleRows) {
            if (ch.unread_message_count === undefined) ch.unread_message_count = 0;
          }
        }
      }

      const response = { channels: rows };
      // Cache per-user per-community for 15 s to absorb repeated REST polls.
      redis.set(cacheKey, JSON.stringify(response), 'EX', 15).catch(() => {});
      res.json(response);
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
    let client;
    try {
      client = await pool.connect();
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
      bustChannelListCache(communityId).catch(() => {});
      res.status(201).json({ channel });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures and surface original error.
        }
        client.release();
      }
      if (err.code === '23505') return res.status(409).json({ error: 'Channel name already exists' });
      next(err);
    }
  }
);

// ── Channel members ───────────────────────────────────────────────────────────
router.get('/:id/members',
  param('id').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    try {
      const channel = await loadChannelContext(req.params.id, req.user.id);
      if (!channel) return res.status(404).json({ error: 'Channel not found' });
      if (!channel.community_role) return res.status(403).json({ error: 'Not a community member' });
      if (channel.is_private && !channel.is_channel_member && !canManagePrivateMembership(channel.community_role)) {
        return res.status(403).json({ error: 'Channel not allowed' });
      }

      const { rows } = await pool.query(
        channel.is_private
          ? `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role
             FROM channel_members chm
             JOIN users u ON u.id = chm.user_id
             JOIN community_members cm
               ON cm.community_id = $2
              AND cm.user_id = u.id
             WHERE chm.channel_id = $1
             ORDER BY u.username`
          : `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role
             FROM community_members cm
             JOIN users u ON u.id = cm.user_id
             WHERE cm.community_id = $2
             ORDER BY u.username`,
        [req.params.id, channel.community_id]
      );

      res.json({ members: rows });
    } catch (err) { next(err); }
  }
);

router.post('/:id/members',
  param('id').isUUID(),
  body('userIds').isArray({ min: 1, max: 50 }),
  body('userIds.*').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    let client;
    try {
      client = await pool.connect();
      const channel = await loadChannelContext(req.params.id, req.user.id);
      if (!channel) {
        client.release();
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (!channel.community_role) {
        client.release();
        return res.status(403).json({ error: 'Not a community member' });
      }
      if (!channel.is_private) {
        client.release();
        return res.status(400).json({ error: 'Only private channels can have invite-only membership' });
      }
      if (!canManagePrivateMembership(channel.community_role)) {
        client.release();
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const requestedUserIds = [...new Set((req.body.userIds || []).filter(Boolean))];
      const { rows: eligibleRows } = await client.query(
        `SELECT user_id::text AS user_id
         FROM community_members
         WHERE community_id = $1
           AND user_id = ANY($2::uuid[])`,
        [channel.community_id, requestedUserIds]
      );
      const eligibleUserIds = eligibleRows.map((row) => row.user_id);
      if (eligibleUserIds.length !== requestedUserIds.length) {
        client.release();
        return res.status(400).json({ error: 'All invited users must already be community members' });
      }

      await client.query('BEGIN');
      const { rows: insertedRows } = await client.query(
        `INSERT INTO channel_members (channel_id, user_id)
         SELECT $1, invited.user_id::uuid
         FROM unnest($2::text[]) AS invited(user_id)
         ON CONFLICT (channel_id, user_id) DO NOTHING
         RETURNING user_id::text AS user_id`,
        [req.params.id, eligibleUserIds]
      );

      const { rows: members } = await client.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, cm.role
         FROM channel_members chm
         JOIN users u ON u.id = chm.user_id
         JOIN community_members cm
           ON cm.community_id = $2
          AND cm.user_id = u.id
         WHERE chm.channel_id = $1
         ORDER BY u.username`,
        [req.params.id, channel.community_id]
      );

      await client.query('COMMIT');
      client.release();

      insertedRows.forEach(({ user_id }) => {
        sideEffects.publishMessageEvent(`user:${user_id}`, 'channel:membership_updated', {
          channelId: req.params.id,
          communityId: channel.community_id,
        });
      });

      res.json({ members, addedUserIds: insertedRows.map((row) => row.user_id) });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures and surface original error.
        }
        client.release();
      }
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
      bustChannelListCache(rows[0].community_id).catch(() => {});
      res.json({ channel: rows[0] });
    } catch (err) { next(err); }
  }
);

// ── Delete ─────────────────────────────────────────────────────────────────────
router.delete('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!v(req, res)) return;
  try {
    const { rows } = await pool.query(
      'DELETE FROM channels WHERE id=$1 RETURNING community_id',
      [req.params.id]
    );
    if (rows.length) bustChannelListCache(rows[0].community_id).catch(() => {});
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
