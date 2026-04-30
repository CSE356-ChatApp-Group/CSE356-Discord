/**
 * POST / — create channel.
 */
const { body } = require('express-validator');
const { getClient } = require('../../db/pool');
const { invalidateWsBootstrapCaches } = require('../../websocket/server');
const S = require('../channelRouterShared');

module.exports = function register(router) {
router.post('/',
  body('communityId').isUUID(),
  body('name').isString().custom((value) => value.trim().length > 0),
  body('isPrivate').optional().isBoolean(),
  body('description').optional().isString(),
  async (req, res, next) => {
    if (!S.v(req, res)) return;
    let client;
    try {
      client = await getClient();
      const { communityId, name, isPrivate = false, description } = req.body;

      // Verify caller is owner/admin in the community
      const { rows: [m] } = await client.query(
        `SELECT role FROM community_members WHERE community_id=$1 AND user_id=$2`,
        [communityId, req.user.id]
      );
      if (!m || !S.canManageChannels(m.role)) {
        client.release();
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO channels (community_id, name, is_private, description, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING ${S.CHANNEL_RETURNING_FIELDS}`,
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
        await S.ensurePrivateChannelManagers(channel.id, communityId, client);
      }

      await client.query('COMMIT');
      client.release();
      client = null;
      await S.bustChannelListCacheForUser(communityId, req.user.id);
      const affectedUserIds = await S.listCommunityUserIds(communityId);
      await invalidateWsBootstrapCaches(affectedUserIds);
      await S.publishChannelLifecycleEvent(communityId, 'channel:created', channel);
      S.bustChannelListCache(communityId).catch(() => {});
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
        const exactConflict = await S.hasExactChannelNameConflict(req.body.communityId, req.body.name).catch(() => false);
        if (exactConflict) return res.status(409).json({ error: 'Channel name already exists' });
      }
      if (S.isBtreeTupleTooLargeError(err)) {
        return res.status(400).json({ error: 'Channel name is too large for indexed storage' });
      }
      next(err);
    }
  }
);
};
