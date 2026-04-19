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
const { query, getClient } = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');
const sideEffects      = require('../messages/sideEffects');
const redis            = require('../db/redis');
const logger           = require('../utils/logger');
const fanout           = require('../websocket/fanout');
const { publishUserFeedTargets } = require('../websocket/userFeed');
const {
  invalidateWsAclCache,
  invalidateWsBootstrapCache,
  evictUnauthorizedChannelSubscribers,
} = require('../websocket/server');
const { invalidateChannelUserFanoutTargetsCache } = require('../messages/channelRealtimeFanout');
const { recordEndpointListCache } = require('../utils/endpointCacheMetrics');

const router = express.Router();
router.use(authenticate);

const CHANNEL_RETURNING_FIELDS = `
  id,
  community_id,
  name,
  description,
  is_private,
  type,
  position,
  created_by,
  created_at,
  updated_at,
  last_message_id,
  last_message_author_id,
  last_message_at`;

const CHANNEL_SELECT_FIELDS = `
  ch.id,
  ch.community_id,
  ch.name,
  ch.description,
  ch.is_private,
  ch.type,
  ch.position,
  ch.created_by,
  ch.created_at,
  ch.updated_at,
  ch.last_message_id,
  ch.last_message_author_id,
  ch.last_message_at`;

const VISIBLE_CHANNEL_FIELDS = `
  vc.id,
  vc.community_id,
  vc.name,
  vc.description,
  vc.is_private,
  vc.type,
  vc.position,
  vc.created_by,
  vc.created_at,
  vc.updated_at`;

function v(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) { res.status(400).json({ errors: e.array() }); return false; }
  return true;
}

async function loadChannelContext(channelId, userId) {
  const { rows } = await query(
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
  return ['owner', 'admin'].includes(role);
}

function canManageChannels(role) {
  return ['owner', 'admin'].includes(role);
}

function isBtreeTupleTooLargeError(err) {
  return err?.code === '54000' && err?.routine === 'index_form_tuple_context';
}

async function hasExactChannelNameConflict(communityId, name, excludeChannelId = null) {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (!communityId || !normalizedName) return false;
  const params = [communityId, normalizedName];
  let sql = `SELECT 1
             FROM channels
             WHERE community_id = $1
               AND name = $2`;
  if (excludeChannelId) {
    params.push(excludeChannelId);
    sql += ` AND id <> $3`;
  }
  sql += ' LIMIT 1';
  const { rows } = await query(sql, params);
  return rows.length > 0;
}

async function listCommunityUserIds(communityId, client = { query }) {
  const { rows } = await client.query(
    'SELECT user_id::text AS user_id FROM community_members WHERE community_id = $1',
    [communityId]
  );
  return rows.map((row) => row.user_id);
}

async function ensurePrivateChannelManagers(channelId, communityId, client) {
  const { rows } = await client.query(
    `SELECT user_id::text AS user_id
     FROM community_members
     WHERE community_id = $1
       AND role IN ('owner', 'admin')`,
    [communityId]
  );

  if (!rows.length) return;

  await client.query(
    `INSERT INTO channel_members (channel_id, user_id)
     SELECT $1, manager.user_id::uuid
     FROM unnest($2::text[]) AS manager(user_id)
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [channelId, rows.map((row) => row.user_id)]
  );
}

async function listChannelLifecycleAudience(communityId, channelId, client = { query }) {
  const { rows } = await client.query(
    `SELECT cm.user_id::text AS user_id,
            (c.is_private = FALSE
             OR EXISTS (
               SELECT 1
               FROM channel_members chm
               WHERE chm.channel_id = c.id
                 AND chm.user_id = cm.user_id
             )) AS can_access
     FROM community_members cm
     JOIN channels c
       ON c.community_id = cm.community_id
      AND c.id = $2
     WHERE cm.community_id = $1`,
    [communityId, channelId]
  );
  return rows;
}

async function publishChannelLifecycleEvent(communityId, event, data) {
  await fanout.publish(`community:${communityId}`, { event, data });

  if (event === 'channel:deleted') {
    const userIds = await listCommunityUserIds(communityId);
    if (userIds.length > 0) {
      await publishUserFeedTargets(userIds, { event, data });
    }
    return;
  }

  const audience = await listChannelLifecycleAudience(communityId, data.id);
  const accessibleUserIds = [];
  const inaccessibleUserIds = [];

  for (const entry of audience) {
    if (entry.can_access) accessibleUserIds.push(entry.user_id);
    else inaccessibleUserIds.push(entry.user_id);
  }

  const publishTasks = [];
  if (accessibleUserIds.length > 0) {
    publishTasks.push(
      publishUserFeedTargets(accessibleUserIds, {
        event,
        data: {
          ...data,
          can_access: true,
          canAccess: true,
        },
      }),
    );
  }
  if (inaccessibleUserIds.length > 0) {
    publishTasks.push(
      publishUserFeedTargets(inaccessibleUserIds, {
        event,
        data: {
          ...data,
          can_access: false,
          canAccess: false,
        },
      }),
    );
  }
  if (publishTasks.length > 0) {
    await Promise.all(publishTasks);
  }
}

/**
 * Bust channels:list cache for every member of a community.
 * Fire-and-forget — runs after the response has been sent.
 */
async function bustChannelListCache(communityId) {
  try {
    const { rows } = await query(
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

/** Same idea as communities/messages list: load tests pin many VUs to one reader user. */
const _channelsListTtl = parseInt(process.env.CHANNELS_LIST_CACHE_TTL_SECS || '60', 10);
const CHANNELS_LIST_CACHE_TTL_SECS =
  Number.isFinite(_channelsListTtl) && _channelsListTtl > 0 ? _channelsListTtl : 60;
const channelsListInflight = new Map();

// ── List ───────────────────────────────────────────────────────────────────────
router.get('/',
  qv('communityId').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    const { communityId } = req.query;
    const userId = req.user.id;
    try {
      // Serve from Redis cache when warm. Channel structure changes are rare;
      // WS events keep the frontend state current.
      const cacheKey = `channels:list:${communityId}:${userId}`;
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        recordEndpointListCache('channels', 'hit');
        return res.json(JSON.parse(cached));
      }

      if (channelsListInflight.has(cacheKey)) {
        recordEndpointListCache('channels', 'coalesced');
        try {
          const result = await channelsListInflight.get(cacheKey);
          if (!result.ok) {
            return res.status(403).json({ error: 'Not a community member' });
          }
          return res.json(result.body);
        } catch (err) {
          return next(err);
        }
      }

      recordEndpointListCache('channels', 'miss');
      const promise = (async () => {
        // Return all visible channel names. Private-channel metadata/content pointers
        // are redacted for users who are not invited to that private channel.
        const { rows } = await query(
          `WITH membership AS (
             SELECT EXISTS (
               SELECT 1
               FROM community_members
               WHERE community_id = $1 AND user_id = $2
             ) AS is_member
           )
           SELECT membership.is_member,
                  ${VISIBLE_CHANNEL_FIELDS},
                  vc.can_access,
                  CASE WHEN vc.can_access THEN vc.last_message_id ELSE NULL END AS last_message_id,
                  CASE WHEN vc.can_access THEN vc.last_message_author_id ELSE NULL END AS last_message_author_id,
                  CASE WHEN vc.can_access THEN vc.last_message_at ELSE NULL END AS last_message_at,
                  CASE WHEN vc.can_access THEN rs.last_read_message_id ELSE NULL END AS my_last_read_message_id,
                  CASE WHEN vc.can_access THEN rs.last_read_at ELSE NULL END AS my_last_read_at
           FROM membership
           LEFT JOIN LATERAL (
             SELECT ${CHANNEL_SELECT_FIELDS},
                    (ch.is_private = FALSE
                     OR EXISTS (
                       SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = ch.id AND cm.user_id = $2
                     )) AS can_access
             FROM channels ch
             WHERE ch.community_id = $1
             ORDER BY ch.position, ch.name
           ) vc ON membership.is_member = TRUE
           LEFT JOIN read_states rs
                  ON vc.can_access
                 AND rs.channel_id = vc.id
                 AND rs.user_id = $2
           ORDER  BY vc.position, vc.name`,
          [communityId, userId]
        );

        if (rows[0] && rows[0].is_member === false) {
          return { ok: false };
        }

        // Attach Redis-backed unread_message_count to each accessible channel
        const accessibleRows = rows.filter(ch => ch.id && ch.can_access);
        if (accessibleRows.length > 0) {
          try {
            const countKeys = accessibleRows.map((ch) => `channel:msg_count:${ch.id}`);
            const readKeys = accessibleRows.map((ch) => `user:last_read_count:${ch.id}:${userId}`);
            const [rawCounts, rawReads] = await Promise.all([
              redis.mget(...countKeys),
              redis.mget(...readKeys),
            ]);

            const missingChannels = [];
            for (let i = 0; i < accessibleRows.length; i++) {
              const ch = accessibleRows[i];
              const rawCount = rawCounts[i];
              const rawRead = rawReads[i];
              if (rawCount === null || rawRead === null) {
                missingChannels.push(ch);
              } else {
                ch.unread_message_count = Math.max(0, parseInt(rawCount, 10) - parseInt(rawRead, 10));
              }
            }

            if (missingChannels.length > 0) {
              // Avoid cold COUNT(*) fallback in this hot path. When Redis counters
              // are missing, infer an unread indicator from denormalized last-read
              // metadata and let async write paths repopulate exact counters.
              for (const ch of missingChannels) {
                const hasUnread =
                  Boolean(ch.last_message_id) &&
                  ch.last_message_id !== ch.my_last_read_message_id &&
                  ch.last_message_author_id !== userId;
                ch.unread_message_count = hasUnread ? 1 : 0;
              }
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to fetch unread counts from Redis; defaulting to 0');
            for (const ch of accessibleRows) {
              if (ch.unread_message_count === undefined) ch.unread_message_count = 0;
            }
          }
        }

        const response = { channels: rows.filter((row) => row.id) };
        redis.set(cacheKey, JSON.stringify(response), 'EX', CHANNELS_LIST_CACHE_TTL_SECS).catch(() => {});
        return { ok: true, body: response };
      })();

      channelsListInflight.set(cacheKey, promise);
      promise.finally(() => channelsListInflight.delete(cacheKey));

      const result = await promise;
      if (!result.ok) {
        return res.status(403).json({ error: 'Not a community member' });
      }
      return res.json(result.body);
    } catch (err) { next(err); }
  }
);

// ── Create ─────────────────────────────────────────────────────────────────────
router.post('/',
  body('communityId').isUUID(),
  body('name').isString().custom((value) => value.trim().length > 0),
  body('isPrivate').optional().isBoolean(),
  body('description').optional().isString(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    let client;
    try {
      client = await getClient();
      const { communityId, name, isPrivate = false, description } = req.body;

      // Verify caller is owner/admin in the community
      const { rows: [m] } = await client.query(
        `SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2`,
        [communityId, req.user.id]
      );
      if (!m || !canManageChannels(m.role)) {
        client.release();
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO channels (community_id, name, is_private, description, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${CHANNEL_RETURNING_FIELDS}`,
        [communityId, name.trim(), isPrivate, description || null, req.user.id]
      );
      const channel = rows[0];

      if (isPrivate) {
        await client.query(
          `INSERT INTO channel_members (channel_id, user_id)
           VALUES ($1,$2)
           ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [channel.id, req.user.id]
        );
        await ensurePrivateChannelManagers(channel.id, communityId, client);
      }

      await client.query('COMMIT');
      client.release();
      client = null;
      const affectedUserIds = await listCommunityUserIds(communityId);
      await Promise.allSettled(
        affectedUserIds.map((userId) => invalidateWsBootstrapCache(userId))
      );
      await publishChannelLifecycleEvent(communityId, 'channel:created', channel);
      bustChannelListCache(communityId).catch(() => {});
      res.status(201).json({ channel });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
        }
        client.release();
      }
      if (err?.code === '23505') {
        const exactConflict = await hasExactChannelNameConflict(req.body.communityId, req.body.name).catch(() => false);
        if (exactConflict) return res.status(409).json({ error: 'Channel name already exists' });
      }
      if (isBtreeTupleTooLargeError(err)) {
        return res.status(400).json({ error: 'Channel name is too large for indexed storage' });
      }
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

      const { rows } = await query(
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
  body('userIds').isArray({ min: 1 }),
  body('userIds.*').isUUID(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    let client;
    try {
      client = await getClient();
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

      await invalidateChannelUserFanoutTargetsCache(req.params.id).catch((err) => {
        logger.warn(
          { err, channelId: req.params.id },
          'Failed to invalidate channel user fanout targets cache after member add',
        );
      });
      const insertedUserIds = insertedRows.map((row) => row.user_id);
      if (insertedUserIds.length > 0) {
        sideEffects.publishMessageEventsToUsers(insertedUserIds, 'channel:membership_updated', {
          channelId: req.params.id,
          communityId: channel.community_id,
        });
        publishUserFeedTargets(insertedUserIds, {
          __wsInternal: {
            kind: 'subscribe_channels',
            channels: [`channel:${req.params.id}`],
          },
        }).catch(() => {});
        redis
          .del(...insertedUserIds.map((userId) => `channels:list:${channel.community_id}:${userId}`))
          .catch(() => {});
      }
      for (const { user_id } of insertedRows) {
        // Expire the WS ACL cache so subsequent subscribe attempts are checked fresh.
        invalidateWsAclCache(user_id, `channel:${req.params.id}`);
        // Rebuild auto-subscribe list on reconnect; otherwise ws:bootstrap cache can omit channel:N.
        invalidateWsBootstrapCache(user_id).catch(() => {});
      }

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
  body('name').optional().isString().custom((value) => value.trim().length > 0),
  body('isPrivate').optional().isBoolean(),
  body('description').optional().isString(),
  async (req, res, next) => {
    if (!v(req, res)) return;
    let client;
    let updateCommunityId = null;
    try {
      client = await getClient();
      const channel = await loadChannelContext(req.params.id, req.user.id);
      if (!channel) {
        client.release();
        client = null;
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (!channel.community_role || !canManageChannels(channel.community_role)) {
        client.release();
        client = null;
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      updateCommunityId = channel.community_id;

      await client.query('BEGIN');
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
        params.push(String(req.body.name).trim());
        updates.push(`name = $${params.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
        params.push(req.body.description ?? null);
        updates.push(`description = $${params.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'isPrivate')) {
        params.push(Boolean(req.body.isPrivate));
        updates.push(`is_private = $${params.length}`);
      }

      if (!updates.length) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return res.status(400).json({ error: 'No changes provided' });
      }

      params.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE channels
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING ${CHANNEL_RETURNING_FIELDS}`,
        params
      );
      const updatedChannel = rows[0];

      if (updatedChannel?.is_private) {
        await ensurePrivateChannelManagers(updatedChannel.id, updatedChannel.community_id, client);
      }

      await client.query('COMMIT');
      client.release();
      client = null;

      const affectedUserIds = await listCommunityUserIds(updatedChannel.community_id);
      await Promise.allSettled([
        invalidateChannelUserFanoutTargetsCache(updatedChannel.id),
        ...affectedUserIds.map((userId) => invalidateWsAclCache(userId, `channel:${updatedChannel.id}`)),
        ...affectedUserIds.map((userId) => invalidateWsBootstrapCache(userId)),
      ]);
      await evictUnauthorizedChannelSubscribers(updatedChannel.id);
      await publishChannelLifecycleEvent(updatedChannel.community_id, 'channel:updated', updatedChannel);
      bustChannelListCache(updatedChannel.community_id).catch(() => {});
      res.json({ channel: updatedChannel });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failures and surface original error.
        }
        client.release();
      }
      if (err?.code === '23505' && Object.prototype.hasOwnProperty.call(req.body, 'name')) {
        const exactConflict = await hasExactChannelNameConflict(
          updateCommunityId,
          req.body.name,
          req.params.id,
        ).catch(() => false);
        if (exactConflict) return res.status(409).json({ error: 'Channel name already exists' });
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body, 'name') &&
        isBtreeTupleTooLargeError(err)
      ) {
        return res.status(400).json({ error: 'Channel name is too large for indexed storage' });
      }
      next(err);
    }
  }
);

// ── Delete ─────────────────────────────────────────────────────────────────────
router.delete('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!v(req, res)) return;
  try {
    const channel = await loadChannelContext(req.params.id, req.user.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.community_role || !canManageChannels(channel.community_role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // FK cascade from messages.channel_id -> channels.id was dropped (migration 023).
    // Delete dependent messages explicitly before removing the channel row.
    await query('DELETE FROM messages WHERE channel_id = $1', [req.params.id]);
    const { rows } = await query(
      'DELETE FROM channels WHERE id=$1 RETURNING id, community_id',
      [req.params.id]
    );
    if (rows.length) {
      const communityId = rows[0].community_id;
      const affectedUserIds = await listCommunityUserIds(communityId);
      await Promise.allSettled([
        invalidateChannelUserFanoutTargetsCache(rows[0].id),
        ...affectedUserIds.map((userId) => invalidateWsBootstrapCache(userId)),
      ]);
      await evictUnauthorizedChannelSubscribers(rows[0].id);
      await publishChannelLifecycleEvent(communityId, 'channel:deleted', {
        id: rows[0].id,
        community_id: communityId,
      });
      // Remove unread-counter helpers for deleted channel to avoid stale key buildup.
      redis.del(`channel:msg_count:${rows[0].id}`).catch(() => {});
      bustChannelListCache(communityId).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
