const { query } = require('../../db/pool');
const redis = require('../../db/redis');
const {
  fanoutTargetCacheTotal,
} = require('../../utils/metrics');
const {
  channelRealtimeConfig: {
    CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS,
  },
} = require('../config/channelRealtimeConfig');
const {
  readVersionedCacheState,
  invalidateVersionedCache,
} = require('./fanoutCacheStoreUtils');

function pgRows(result: unknown): { user_id?: string; id?: string; community_id?: string; is_private?: boolean }[] {
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: { user_id?: string; id?: string; community_id?: string; is_private?: boolean }[] })
      .rows;
  }
  return [];
}

const channelUserFanoutTargetsInflight: Map<string, Promise<string[]>> = new Map();
const channelRealtimeMetaCache: Map<string, {
  communityId: string | null;
  isPrivate: boolean;
  cachedAt: number;
}> = new Map();
const channelRealtimeMetaInflight: Map<string, Promise<{
  communityId: string | null;
  isPrivate: boolean;
}>> = new Map();
const CHANNEL_REALTIME_META_CACHE_MS = 5 * 60 * 1000;

const CHANNEL_USER_FANOUT_TARGETS_SQL = `
  SELECT DISTINCT cm.user_id::text AS user_id
  FROM channels c
  JOIN community_members cm ON cm.community_id = c.community_id
  LEFT JOIN channel_members chm
    ON chm.channel_id = c.id
   AND chm.user_id = cm.user_id
  WHERE c.id = $1
    AND (c.is_private = FALSE OR chm.user_id IS NOT NULL)
`;

function channelUserFanoutTargetsCacheKey(channelId: string) {
  return `channel:${channelId}:user_fanout_targets`;
}

function channelUserFanoutTargetsVersionKey(channelId: string) {
  return `channel:${channelId}:user_fanout_targets_v`;
}

function parseChannelUserFanoutTargetsCached(cached: string): string[] | null {
  try {
    const parsed = JSON.parse(cached);
    if (Array.isArray(parsed)) {
      return parsed.filter((value: unknown) => typeof value === 'string');
    }
    if (
      parsed
      && typeof parsed === 'object'
      && (parsed as { v?: unknown; u?: unknown }).v === 2
      && Array.isArray((parsed as { u?: unknown }).u)
    ) {
      return (parsed as { u: string[] }).u
        .filter((id: unknown) => typeof id === 'string' && id.length > 0)
        .map((id: string) => `user:${id}`);
    }
  } catch {
    return null;
  }
  return null;
}

function invalidateChannelRealtimeMeta(channelId: string) {
  channelRealtimeMetaCache.delete(channelId);
  channelRealtimeMetaInflight.delete(channelId);
}

async function invalidateChannelUserFanoutTargetsCache(channelId: string) {
  invalidateChannelRealtimeMeta(channelId);
  const cacheKey = channelUserFanoutTargetsCacheKey(channelId);
  const versionKey = channelUserFanoutTargetsVersionKey(channelId);
  await invalidateVersionedCache(cacheKey, versionKey);
}

async function getCommunityChannelIds(communityId: string): Promise<string[]> {
  const rows = pgRows(
    await query(`SELECT id::text AS id FROM channels WHERE community_id = $1`, [communityId]),
  );
  return rows.map((row: { id: string }) => row.id);
}

async function getChannelRealtimeMeta(channelId: string): Promise<{
  communityId: string | null;
  isPrivate: boolean;
}> {
  const cached = channelRealtimeMetaCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt <= CHANNEL_REALTIME_META_CACHE_MS) {
    return { communityId: cached.communityId, isPrivate: cached.isPrivate };
  }

  const inFlight = channelRealtimeMetaInflight.get(channelId);
  if (inFlight) return inFlight;

  const load = (async () => {
    const rows = pgRows(
      await query(
        `SELECT community_id::text AS community_id, is_private
         FROM channels
         WHERE id = $1`,
        [channelId],
      ),
    );
    const row = rows[0] || {};
    const meta = {
      communityId: typeof row.community_id === 'string' ? row.community_id : null,
      isPrivate: row.is_private === true,
    };
    channelRealtimeMetaCache.set(channelId, { ...meta, cachedAt: Date.now() });
    return meta;
  })().finally(() => {
    channelRealtimeMetaInflight.delete(channelId);
  });

  channelRealtimeMetaInflight.set(channelId, load);
  return load;
}

async function invalidateCommunityChannelUserFanoutTargetsCache(
  communityId: string,
  preloadedChannelIds?: string[] | null,
) {
  const ids =
    Array.isArray(preloadedChannelIds) && preloadedChannelIds.length
      ? preloadedChannelIds
      : await getCommunityChannelIds(communityId);

  if (!ids.length) return;

  try {
    const pipeline = redis.pipeline();
    ids.forEach((id) => {
      pipeline.del(channelUserFanoutTargetsCacheKey(id));
      pipeline.incr(channelUserFanoutTargetsVersionKey(id));
    });
    await pipeline.exec();
  } catch {
    await Promise.allSettled(ids.map((id) => invalidateChannelUserFanoutTargetsCache(id)));
  }
}

async function getChannelUserFanoutTargetKeys(channelId: string): Promise<string[]> {
  const { targets } = await getChannelUserFanoutTargetKeysWithMeta(channelId);
  return targets;
}

async function queryChannelUserFanoutTargets(channelId: string): Promise<string[]> {
  const rows = pgRows(await query(CHANNEL_USER_FANOUT_TARGETS_SQL, [channelId]));
  return Array.from(new Set(rows.map((r: { user_id: string }) => `user:${r.user_id}`)));
}

async function getChannelUserFanoutTargetKeysWithMeta(channelId: string): Promise<{
  targets: string[];
  cacheResult: 'hit' | 'miss' | 'coalesced';
}> {
  const cacheKey = channelUserFanoutTargetsCacheKey(channelId);
  const versionKey = channelUserFanoutTargetsVersionKey(channelId);
  const { cached, version: cachedVersion } = await readVersionedCacheState(cacheKey, versionKey);
  if (cached) {
    const fromCache = parseChannelUserFanoutTargetsCached(cached);
    if (fromCache !== null) {
      fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'hit' });
      return {
        targets: fromCache,
        cacheResult: 'hit',
      };
    }
    redis.del(cacheKey).catch(() => {});
  }

  if (channelUserFanoutTargetsInflight.has(cacheKey)) {
    fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'coalesced' });
    return {
      targets: await channelUserFanoutTargetsInflight.get(cacheKey),
      cacheResult: 'coalesced',
    };
  }

  fanoutTargetCacheTotal.inc({ path: 'channel_message_user_topics', result: 'miss' });
  const maxVersionRetries = 8;
  const load: Promise<string[]> = (async (): Promise<string[]> => {
    for (let attempt = 0; attempt < maxVersionRetries; attempt += 1) {
      const vBeforeQuery = attempt === 0
        ? Number(cachedVersion || 0)
        : Number((await redis.get(versionKey).catch(() => null)) || 0);
      const keys = await queryChannelUserFanoutTargets(channelId);
      const vAfterQuery = Number((await redis.get(versionKey).catch(() => null)) || 0);
      if (vBeforeQuery !== vAfterQuery) {
        continue;
      }

      const compact = {
        v: 2 as const,
        u: keys.map((k) => (k.startsWith('user:') ? k.slice('user:'.length) : k)),
      };
      redis
        .set(cacheKey, JSON.stringify(compact), 'EX', CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS)
        .catch(() => {});
      return keys;
    }

    return queryChannelUserFanoutTargets(channelId);
  })().finally(() => {
    channelUserFanoutTargetsInflight.delete(cacheKey);
  });

  channelUserFanoutTargetsInflight.set(cacheKey, load);
  return { targets: await load, cacheResult: 'miss' };
}

module.exports = {
  getChannelUserFanoutTargetKeys,
  getChannelUserFanoutTargetKeysWithMeta,
  getChannelRealtimeMeta,
  getCommunityChannelIds,
  invalidateChannelUserFanoutTargetsCache,
  invalidateCommunityChannelUserFanoutTargetsCache,
};

