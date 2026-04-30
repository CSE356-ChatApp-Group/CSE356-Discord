/**
 * GET|POST /:id/members — list or add private-channel members.
 */
const { body, param } = require('express-validator');
const { queryRead, getClient } = require('../../db/pool');
const sideEffects = require('../../messages/sideEffects');
const redis = require('../../db/redis');
const logger = require('../../utils/logger');
const { publishUserFeedTargets } = require('../../websocket/userFeed');
const { invalidateWsAclCache, invalidateWsBootstrapCaches } = require('../../websocket/server');
const { staleCacheKey } = require('../../utils/distributedSingleflight');
const { raceChannelAccess } = require('../../messages/channelAccessCache');
const { invalidateChannelUserFanoutTargetsCache } = require('../../messages/channelRealtimeFanout');
const S = require('../channelRouterShared');

module.exports = function register(router) {
router.get('/:id/members',
  param('id').isUUID(),
  async (req, res, next) => {
    if (!S.v(req, res)) return;
    try {
      const { rows: channelRows } = await queryRead(
        `SELECT id, community_id, is_private FROM channels WHERE id = $1`,
        [req.params.id],
      );
      const channel = channelRows[0];
      if (!channel) return res.status(404).json({ error: 'Channel not found' });

      const hasAccess = await raceChannelAccess(
        redis,
        req.params.id,
        req.user.id,
        () => S.checkChannelAccessForUser(req.params.id, req.user.id),
      );
      if (!hasAccess) return res.status(403).json({ error: 'Forbidden' });

      const { rows } = await queryRead(
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
    if (!S.v(req, res)) return;
    let client;
    try {
      client = await getClient();
      const channel = await S.loadChannelContext(req.params.id, req.user.id);
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
      if (!S.canManagePrivateMembership(channel.community_role)) {
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
        const keys = insertedUserIds.flatMap((userId) => {
          const key = `channels:list:${channel.community_id}:${userId}`;
          return [key, staleCacheKey(key)];
        });
        redis.del(...keys).catch(() => {});
      }
      for (const { user_id } of insertedRows) {
        // Expire the WS ACL cache so subsequent subscribe attempts are checked fresh.
        invalidateWsAclCache(user_id, `channel:${req.params.id}`);
      }
      // Rebuild auto-subscribe list on reconnect; otherwise ws:bootstrap cache can omit channel:N.
      invalidateWsBootstrapCaches(insertedRows.map((row) => row.user_id)).catch(() => {});

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
};
