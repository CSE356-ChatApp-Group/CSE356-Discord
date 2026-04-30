/**
 * GET / — list channels for a community (cached + singleflight).
 */
const { query: qv } = require('express-validator');
const { query, queryRead } = require('../../db/pool');
const redis = require('../../db/redis');
const logger = require('../../utils/logger');
const { recordEndpointListCache } = require('../../utils/endpointCacheMetrics');
const {
  staleCacheKey,
  getJsonCache,
  setJsonCacheWithStale,
  withDistributedSingleflight,
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
    try {
      // Serve from Redis cache when warm. Channel structure changes are rare;
      // WS events keep the frontend state current.
      const cacheKey = `channels:list:${communityId}:${userId}`;
      const cached = await getJsonCache(redis, cacheKey);
      if (cached) {
        recordEndpointListCache('channels', 'hit');
        return res.json(cached);
      }

      if (S.channelsListInflight.has(cacheKey)) {
        recordEndpointListCache('channels', 'coalesced');
        try {
          const result = await S.channelsListInflight.get(cacheKey);
          if (!result.ok) {
            return res.status(403).json({ error: 'Not a community member' });
          }
          return res.json(result.body);
        } catch (err) {
          return next(err);
        }
      }

      recordEndpointListCache('channels', 'miss');
      const promise = withDistributedSingleflight({
        redis,
        cacheKey,
        inflight: S.channelsListInflight,
        readFresh: async () => getJsonCache(redis, cacheKey),
        readStale: async () => getJsonCache(redis, staleCacheKey(cacheKey)),
        load: async () => {
          // Access control must read from primary to avoid replica lag causing false 403s
          // immediately after a user joins a community.
          const { rows: memberRows } = await query(
            'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2 LIMIT 1',
            [communityId, userId]
          );
          if (memberRows.length === 0) {
            return { ok: false };
          }

          // Return all visible channel names. Private-channel metadata/content pointers
          // are redacted for users who are not invited to that private channel.
          // Fall back to primary if the replica returns 0 rows — this handles the
          // replication lag window after community creation where the default channel
          // exists on primary but hasn't replicated yet.
          const channelListSql = `SELECT ${S.VISIBLE_CHANNEL_FIELDS},
                  vc.can_access,
                  CASE WHEN vc.can_access THEN vc.last_message_id ELSE NULL END AS last_message_id,
                  CASE WHEN vc.can_access THEN vc.last_message_author_id ELSE NULL END AS last_message_author_id,
                  CASE WHEN vc.can_access THEN vc.last_message_at ELSE NULL END AS last_message_at,
                  CASE WHEN vc.can_access THEN rs.last_read_message_id ELSE NULL END AS my_last_read_message_id,
                  CASE WHEN vc.can_access THEN rs.last_read_at ELSE NULL END AS my_last_read_at
           FROM LATERAL (
             SELECT ${S.CHANNEL_SELECT_FIELDS},
                    (ch.is_private = FALSE
                     OR EXISTS (
                       SELECT 1 FROM channel_members cm
                       WHERE cm.channel_id = ch.id AND cm.user_id = $2
                     )) AS can_access
             FROM channels ch
             WHERE ch.community_id = $1
             ORDER BY ch.position, ch.name
           ) vc
           LEFT JOIN read_states rs
                  ON vc.can_access
                 AND rs.channel_id = vc.id
                 AND rs.user_id = $2
           ORDER  BY vc.position, vc.name`;
          let { rows } = await queryRead(channelListSql, [communityId, userId]);
          if (rows.length === 0) {
            ({ rows } = await query(channelListSql, [communityId, userId]));
          }

          const accessibleRows = rows.filter((ch) => ch.id && ch.can_access);
          const latestByChannel = await getChannelLastMessageMetaMapFromRedis(
            accessibleRows.map((ch) => ch.id),
            'channel',
          );
          S.applyChannelLastMessageMetadata(accessibleRows, latestByChannel);

          // Attach Redis-backed unread_message_count to each accessible channel
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
              // Opportunistic TTL repair for legacy channel:msg_count keys created without EX.
              // Best-effort only; never block the response path.
              const ttlRepair = redis.pipeline();
              let ttlRepairOps = 0;
              for (let i = 0; i < accessibleRows.length; i += 1) {
                if (rawCounts[i] === null) continue;
                ttlRepair.expire(countKeys[i], S.CHANNEL_MSG_COUNT_REDIS_TTL_SECS);
                ttlRepairOps += 1;
              }
              if (ttlRepairOps > 0) {
                ttlRepair.exec().catch(() => {});
              }
            } catch (err) {
              logger.warn({ err }, 'Failed to fetch unread counts from Redis; defaulting to 0');
              for (const ch of accessibleRows) {
                if (ch.unread_message_count === undefined) ch.unread_message_count = 0;
              }
            }
          }

          const response = { channels: rows.filter((row) => row.id) };
          await setJsonCacheWithStale(redis, cacheKey, response, S.CHANNELS_LIST_CACHE_TTL_SECS, {
            staleMultiplier: 1.25,
            maxStaleTtlSeconds: 180,
          });
          return { ok: true, body: response };
        },
      });

      const result = await promise;
      if (!result.ok) {
        return res.status(403).json({ error: 'Not a community member' });
      }
      return res.json(result.body);
    } catch (err) { next(err); }
  }
);
};
