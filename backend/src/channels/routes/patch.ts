/**
 * PATCH /:id — update channel.
 */
const { body, param } = require('express-validator');
const { getClient } = require('../../db/pool');
const {
  invalidateWsAclCache,
  invalidateWsBootstrapCaches,
  evictUnauthorizedChannelSubscribers,
} = require('../../websocket/server');
const { invalidateChannelUserFanoutTargetsCache } = require('../../messages/channelRealtimeFanout');
const S = require('../channelRouterShared');

module.exports = function register(router) {
router.patch('/:id',
  param('id').isUUID(),
  body('name').optional().isString().custom((value) => value.trim().length > 0),
  body('isPrivate').optional().isBoolean(),
  body('description').optional().isString(),
  async (req, res, next) => {
    if (!S.v(req, res)) return;
    let client;
    let updateCommunityId = null;
    try {
      client = await getClient();
      const channel = await S.loadChannelContext(req.params.id, req.user.id);
      if (!channel) {
        client.release();
        client = null;
        return res.status(404).json({ error: 'Channel not found' });
      }
      if (!channel.community_role || !S.canManageChannels(channel.community_role)) {
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
         RETURNING ${S.CHANNEL_RETURNING_FIELDS}`,
        params
      );
      const updatedChannel = rows[0];

      if (updatedChannel?.is_private) {
        await S.ensurePrivateChannelManagers(updatedChannel.id, updatedChannel.community_id, client);
      }

      await client.query('COMMIT');
      client.release();
      client = null;

      const affectedUserIds = await S.listCommunityUserIds(updatedChannel.community_id);
      await Promise.allSettled([
        invalidateChannelUserFanoutTargetsCache(updatedChannel.id),
        ...affectedUserIds.map((userId) => invalidateWsAclCache(userId, `channel:${updatedChannel.id}`)),
        invalidateWsBootstrapCaches(affectedUserIds),
      ]);
      await evictUnauthorizedChannelSubscribers(updatedChannel.id);
      await S.publishChannelLifecycleEvent(updatedChannel.community_id, 'channel:updated', updatedChannel);
      S.bustChannelListCache(updatedChannel.community_id).catch(() => {});
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
        const exactConflict = await S.hasExactChannelNameConflict(
          updateCommunityId,
          req.body.name,
          req.params.id,
        ).catch(() => false);
        if (exactConflict) return res.status(409).json({ error: 'Channel name already exists' });
      }
      if (
        Object.prototype.hasOwnProperty.call(req.body, 'name') &&
        S.isBtreeTupleTooLargeError(err)
      ) {
        return res.status(400).json({ error: 'Channel name is too large for indexed storage' });
      }
      next(err);
    }
  }
);
};
