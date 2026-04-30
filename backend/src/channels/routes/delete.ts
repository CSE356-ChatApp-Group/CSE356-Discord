/**
 * DELETE /:id — remove channel and dependent rows.
 */
const { param } = require('express-validator');
const { query } = require('../../db/pool');
const redis = require('../../db/redis');
const {
  invalidateWsBootstrapCaches,
  evictUnauthorizedChannelSubscribers,
} = require('../../websocket/server');
const { invalidateChannelUserFanoutTargetsCache } = require('../../messages/channelRealtimeFanout');
const S = require('../channelRouterShared');

module.exports = function register(router) {
router.delete('/:id', param('id').isUUID(), async (req, res, next) => {
  if (!S.v(req, res)) return;
  try {
    const channel = await S.loadChannelContext(req.params.id, req.user.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!channel.community_role || !S.canManageChannels(channel.community_role)) {
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
      const affectedUserIds = await S.listCommunityUserIds(communityId);
      await Promise.allSettled([
        invalidateChannelUserFanoutTargetsCache(rows[0].id),
        invalidateWsBootstrapCaches(affectedUserIds),
      ]);
      await evictUnauthorizedChannelSubscribers(rows[0].id);
      await S.publishChannelLifecycleEvent(communityId, 'channel:deleted', {
        id: rows[0].id,
        community_id: communityId,
      });
      // Remove unread-counter helpers for deleted channel to avoid stale key buildup.
      redis.del(`channel:msg_count:${rows[0].id}`).catch(() => {});
      S.bustChannelListCache(communityId).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});
};
