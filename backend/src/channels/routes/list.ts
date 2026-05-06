/**
 * GET / — list channels for a community.
 *
 * Two-tier cache:
 *   channels:community:<communityId>  — shared structural cache (all users, no per-user fields)
 *   Per-user data fetched fresh on every request:
 *     - private-channel access  (channel_members, primary)
 *     - read states             (read_states, replica via idx_read_states_user_target)
 *     - unread counts           (Redis counters)
 *   Last-message metadata applied from Redis on every serve (never stale in cache).
 */
const { query: qv } = require('express-validator');
const { query, queryRead } = require('../../db/pool');
const redis = require('../../db/redis');
const { redisBatchMget } = require('../../db/redisBatch');
const { countKeyForChannel, userLastReadCountKey } = require('../../messages/channelMessageCounter');
const logger = require('../../utils/logger');
const { recordEndpointListCache } = require('../../utils/endpointCacheMetrics');
const {
  getJsonCache,
  setJsonCacheWithStale,
} = require('../../utils/distributedSingleflight');
const { getChannelLastMessageMetaMapFromRedis } = require('../../messages/repointLastMessage');
const S = require('../channelRouterShared');

module.exports = function register(router) {
router.get('/',
  qv('communityId').isUUID(),
  async (req, res, next) => {
    if (!S.v(req, res)) return;
    const { communityId } = req.query;
    const userId = req.user.id;
    const commCacheKey = `channels:community:${communityId}`;

    try {
      // Auth check (primary — avoid false 403 after recent join) and community
      // structural cache retrieval run in parallel.
      const [{ rows: memberRows }, cachedStructure] = await Promise.all([
        query(
          'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 LIMIT 1',
          [communityId, userId],
        ),
        getJsonCache(redis, commCacheKey),
      ]);

      if (memberRows.length === 0) {
        recordEndpointListCache('channels', 'miss');
        return res.status(403).json({ error: 'Not a community member' });
      }

      // Load community channel structure — shared cache, no user-specific fields.
      let channelRows;
      if (cachedStructure) {
        recordEndpointListCache('channels', 'hit');
        channelRows = cachedStructure;
      } else {
        recordEndpointListCache('channels', 'miss');
        // In-process singleflight: coalesce concurrent cold-cache requests per community.
        if (S.communityChannelsInflight.has(commCacheKey)) {
          channelRows = await S.communityChannelsInflight.get(commCacheKey);
        } else {
          const loadPromise = (async () => {
            const fresh = await getJsonCache(redis, commCacheKey);
            if (fresh) return fresh;
            const { rows } = await query(
              `SELECT ${S.CHANNEL_SELECT_FIELDS} FROM channels ch WHERE ch.community_id = $1 ORDER BY ch.position, ch.name`,
              [communityId],
            );
            setJsonCacheWithStale(redis, commCacheKey, rows, S.CHANNELS_LIST_CACHE_TTL_SECS, {
              staleMultiplier: 1.25,
              maxStaleTtlSeconds: 180,
            }).catch(() => {});
            return rows;
          })().finally(() => S.communityChannelsInflight.delete(commCacheKey));
          S.communityChannelsInflight.set(commCacheKey, loadPromise);
          channelRows = await loadPromise;
        }
      }

      if (!channelRows || !channelRows.length) {
        return res.json({ channels: [] });
      }

      // Per-user data: private access + last-message metadata + read states — all parallel.
      const privateChannelIds = channelRows.filter((ch) => ch.is_private).map((ch) => ch.id);
      const allChannelIds = channelRows.map((ch) => ch.id);

      const [privateAccessResult, latestByChannel, readStateResult] = await Promise.all([
        privateChannelIds.length > 0
          ? query(
              'SELECT channel_id::text FROM channel_members WHERE channel_id = ANY($1::uuid[]) AND user_id = $2',
              [privateChannelIds, userId],
            )
          : Promise.resolve({ rows: [] }),
        getChannelLastMessageMetaMapFromRedis(allChannelIds, 'channel'),
        queryRead(
          'SELECT channel_id::text, last_read_message_id::text, last_read_at FROM read_states WHERE user_id = $1 AND channel_id = ANY($2::uuid[])',
          [userId, allChannelIds],
        ).catch(() => ({ rows: [] })),
      ]);

      const privateAccessSet = new Set(privateAccessResult.rows.map((r) => r.channel_id));
      const readStateMap = new Map();
      for (const rs of readStateResult.rows) {
        readStateMap.set(rs.channel_id, rs);
      }

      // Apply Redis last-message overlay (mutates local copy, not the Redis cache).
      S.applyChannelLastMessageMetadata(channelRows, latestByChannel);

      const accessibleChannelIds = channelRows
        .filter((ch) => !ch.is_private || privateAccessSet.has(ch.id))
        .map((ch) => ch.id);

      // Unread counts from Redis for accessible channels only.
      const unreadMap = new Map();
      if (accessibleChannelIds.length > 0) {
        try {
          const countKeys = accessibleChannelIds.map(countKeyForChannel);
          const readKeys = accessibleChannelIds.map((id) => userLastReadCountKey(id, userId));
          const [rawCounts, rawReads] = await Promise.all([
            redisBatchMget(redis, countKeys),
            redisBatchMget(redis, readKeys),
          ]);

          const missingIds = [];
          for (let i = 0; i < accessibleChannelIds.length; i++) {
            const chId = accessibleChannelIds[i];
            const rawCount = rawCounts[i];
            const rawRead = rawReads[i];
            if (rawCount === null || rawRead === null) {
              missingIds.push(chId);
            } else {
              unreadMap.set(chId, Math.max(0, parseInt(rawCount, 10) - parseInt(rawRead, 10)));
            }
          }

          // Infer unread indicator from last-message metadata when Redis counters are absent.
          for (const chId of missingIds) {
            const ch = channelRows.find((c) => c.id === chId);
            const rs = readStateMap.get(chId);
            const hasUnread =
              Boolean(ch?.last_message_id) &&
              ch.last_message_id !== rs?.last_read_message_id &&
              ch.last_message_author_id !== userId;
            unreadMap.set(chId, hasUnread ? 1 : 0);
          }

          // Opportunistic TTL repair for legacy keys created without EX.
          setImmediate(() => {
            try {
              const ttlRepair = redis.pipeline();
              let ttlRepairOps = 0;
              for (let i = 0; i < accessibleChannelIds.length; i++) {
                if (rawCounts[i] === null) continue;
                ttlRepair.expire(countKeys[i], S.CHANNEL_MSG_COUNT_REDIS_TTL_SECS);
                ttlRepairOps += 1;
              }
              if (ttlRepairOps > 0) ttlRepair.exec().catch(() => {});
            } catch {
              // best-effort; never throw in setImmediate
            }
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to fetch unread counts from Redis; defaulting to 0');
        }
      }

      // Assemble full channel list with per-user overlay.
      const channels = channelRows.map((ch) => {
        const canAccess = !ch.is_private || privateAccessSet.has(ch.id);
        const rs = canAccess ? readStateMap.get(ch.id) : null;
        return {
          ...ch,
          can_access: canAccess,
          last_message_id: canAccess ? ch.last_message_id : null,
          last_message_author_id: canAccess ? ch.last_message_author_id : null,
          last_message_at: canAccess ? ch.last_message_at : null,
          my_last_read_message_id: rs ? rs.last_read_message_id : null,
          my_last_read_at: rs ? rs.last_read_at : null,
          unread_message_count: canAccess ? (unreadMap.get(ch.id) ?? 0) : 0,
        };
      });

      return res.json({ channels });
    } catch (err) { next(err); }
  }
);
};
