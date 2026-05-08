jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  queryRead: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  del: jest.fn().mockResolvedValue(1),
}));

jest.mock('../src/db/redisBatch', () => ({
  redisBatchUnlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  debug: jest.fn(),
  isLevelEnabled: jest.fn(() => false),
}));

jest.mock('../src/presence/service', () => ({
  invalidatePresenceFanoutTargetsBulk: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/websocket/communityFeed', () => ({
  publishCommunityFeedMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/websocket/server', () => ({
  invalidateWsBootstrapCache: jest.fn().mockResolvedValue(undefined),
  invalidateWsAclCache: jest.fn(),
}));

jest.mock('../src/messages/fanout/channelRealtimeFanout', () => ({
  invalidateCommunityChannelUserFanoutTargetsCache: jest.fn().mockResolvedValue(undefined),
  getCommunityChannelIds: jest.fn().mockResolvedValue(['chan-1', 'chan-2']),
}));

jest.mock('../src/messages/channelAccessCache', () => ({
  warmChannelAccessCacheForUser: jest.fn().mockResolvedValue(undefined),
  evictChannelAccessCacheForUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/websocket/recentConnect', () => ({
  markChannelBootstrapPending: jest.fn().mockResolvedValue(undefined),
  markChannelsRecentConnect: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/communities/listCache', () => ({
  _communitiesTtl: 60,
  COMMUNITIES_CACHE_TTL_SECS: 60,
  _communitiesPagedTtl: 60,
  COMMUNITIES_PAGED_CACHE_TTL_SECS: 60,
  COMMUNITIES_LAST_GOOD_CACHE_TTL_SECS: 60,
  _communitiesVersionTtl: 60,
  COMMUNITIES_VERSION_CACHE_TTL_SECS: 60,
  redisExpireBestEffort: jest.fn().mockResolvedValue(undefined),
  invalidateCommunitiesCaches: jest.fn().mockResolvedValue(undefined),
  getPublicCommunitiesVersion: jest.fn().mockResolvedValue(1),
  bumpPublicCommunitiesVersion: jest.fn().mockResolvedValue(1),
  getCommunitiesUserVersion: jest.fn().mockResolvedValue(1),
  readLastGoodCommunitiesPayload: jest.fn().mockResolvedValue(null),
  writeLastGoodCommunitiesPayload: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/communities/communityMemberCount', () => ({
  incrCommunityMemberCount: jest.fn().mockResolvedValue(undefined),
  decrCommunityMemberCount: jest.fn().mockResolvedValue(undefined),
  getCommunityMemberCountsFromRedis: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../src/communities/communityMembershipCache', () => ({
  COMMUNITY_MEMBERSHIP_TTL_SECS: 3600,
  isUserCommunityMember: jest.fn().mockResolvedValue(false),
  recordUserCommunityMembership: jest.fn().mockResolvedValue(undefined),
  refreshUserCommunityMembershipTtl: jest.fn().mockResolvedValue(undefined),
  forgetUserCommunityMembership: jest.fn().mockResolvedValue(undefined),
  forgetUserCommunityMembershipBulk: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
  recordEndpointListCacheBypass: jest.fn(),
}));

jest.mock('../src/utils/distributedSingleflight', () => ({
  getJsonCache: jest.fn().mockResolvedValue(null),
  setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
  withDistributedSingleflight: jest.fn(({ load }) => load()),
}));

jest.mock('../src/messages/repointLastMessage', () => ({
  getChannelLastMessageMetaMapFromRedis: jest.fn().mockResolvedValue(new Map()),
}));

const { query } = require('../src/db/pool') as { query: jest.Mock };
const { publishUserFeedTargets } = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: jest.Mock;
};
const {
  markChannelBootstrapPending,
  markChannelsRecentConnect,
} = require('../src/websocket/recentConnect') as {
  markChannelBootstrapPending: jest.Mock;
  markChannelsRecentConnect: jest.Mock;
};
const { executeResolvedPublicJoin } = require('../src/communities/communityShared') as {
  executeResolvedPublicJoin: (req: any, res: any, next: any, resolved: any) => Promise<void>;
};

describe('public community join WS priming', () => {
  beforeEach(() => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO community_members')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT c.id::text AS id')) {
        return { rows: [{ id: 'chan-1' }, { id: 'chan-2' }] };
      }
      if (sql.includes('SELECT user_id::text AS user_id')) {
        return { rows: [{ user_id: 'joiner-1' }] };
      }
      return { rows: [] };
    });
    publishUserFeedTargets.mockClear();
    markChannelBootstrapPending.mockReset();
    markChannelsRecentConnect.mockReset();
  });

  it('does not publish subscribe_channels until joined channels are primed for narrow bridge delivery', async () => {
    let releaseBootstrap: (() => void) | undefined;
    let releaseRecent: (() => void) | undefined;
    markChannelBootstrapPending.mockImplementation(
      () => new Promise<void>((resolve) => { releaseBootstrap = resolve; }),
    );
    markChannelsRecentConnect.mockImplementation(
      () => new Promise<void>((resolve) => { releaseRecent = resolve; }),
    );
    publishUserFeedTargets.mockResolvedValue(undefined);

    const req = { user: { id: 'joiner-1' } };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    const joinPromise = executeResolvedPublicJoin(req, res, next, {
      ok: true,
      isPublic: true,
      id: 'community-1',
    });

    for (let i = 0; i < 10 && markChannelBootstrapPending.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(markChannelBootstrapPending).toHaveBeenCalledWith('joiner-1', ['chan-1', 'chan-2']);
    expect(markChannelsRecentConnect).toHaveBeenCalledWith('joiner-1', ['chan-1', 'chan-2']);
    expect(publishUserFeedTargets).not.toHaveBeenCalled();

    releaseBootstrap?.();
    releaseRecent?.();
    await joinPromise;

    expect(publishUserFeedTargets).toHaveBeenCalledWith(['joiner-1'], {
      __wsInternal: {
        kind: 'subscribe_channels',
        channels: ['community:community-1', 'channel:chan-1', 'channel:chan-2'],
      },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(next).not.toHaveBeenCalled();
  });
});
