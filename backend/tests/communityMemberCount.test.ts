/**
 * Tests for communityMemberCount.ts:
 *   - incrCommunityMemberCount / decrCommunityMemberCount fire-and-forget Redis writes
 *   - getCommunityMemberCountsFromRedis read with hit/miss/error paths
 *   - runReconcile: skip cases + batch UPDATE + Redis sync
 *
 * Plus router-level smoke tests for the join/leave endpoints and the list member_count overlay.
 */

import express from 'express';
import request from 'supertest';

// ── Module mocks ────────────────────────────────────────────────────────────────

const redisMock = {
  pipeline: jest.fn(),
  hmget: jest.fn(),
  hset: jest.fn(),
  set: jest.fn(),
  eval: jest.fn(),
  srem: jest.fn(),
  sscan: jest.fn(),
  smembers: jest.fn(),
  sadd: jest.fn(),
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
};

jest.mock('../src/db/redis', () => redisMock);

const poolMock = {
  query: jest.fn(),
  queryRead: jest.fn(),
  getClient: jest.fn(),
  poolStats: jest.fn(),
};
jest.mock('../src/db/pool', () => poolMock);

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const metricsMock = {
  communityCountRedisUpdateTotal: { inc: jest.fn() },
  communityCountPgReconcileTotal: { inc: jest.fn() },
  communityCountPgReconcileSkippedTotal: { inc: jest.fn() },
  communityCountCacheTotal: { inc: jest.fn() },
  // Router and other metrics used by communities/router
  apiRateLimitHitsTotal: { inc: jest.fn() },
};
jest.mock('../src/utils/metrics', () => metricsMock);

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));
jest.mock('../src/presence/service', () => ({
  invalidatePresenceFanoutTargets: jest.fn().mockResolvedValue(undefined),
  getBulkPresenceDetails: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/websocket/fanout', () => {
  const fanoutPublishMock = jest.fn().mockResolvedValue(undefined);
  const fanoutPublishBatchMock = jest.fn(async (entries) => {
    for (const e of entries) await fanoutPublishMock(e.channel, e.payload);
  });
  return { publish: fanoutPublishMock, publishBatch: fanoutPublishBatchMock };
});
jest.mock('../src/websocket/userFeed', () => ({ publishUserFeedTargets: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/websocket/server', () => ({
  invalidateWsBootstrapCache: jest.fn().mockResolvedValue(undefined),
  invalidateWsAclCache: jest.fn(),
}));
jest.mock('../src/messages/channelRealtimeFanout', () => ({
  invalidateCommunityChannelUserFanoutTargetsCache: jest.fn().mockResolvedValue(undefined),
  getCommunityChannelIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/messages/channelAccessCache', () => ({
  warmChannelAccessCacheForUser: jest.fn().mockResolvedValue(undefined),
  evictChannelAccessCacheForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/messages/repointLastMessage', () => ({
  getChannelLastMessageMetaMapFromRedis: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
  recordEndpointListCacheBypass: jest.fn(),
}));
jest.mock('../src/utils/distributedSingleflight', () => ({
  staleCacheKey: jest.fn((k) => `stale:${k}`),
  getJsonCache: jest.fn().mockResolvedValue(null),
  setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
  withDistributedSingleflight: jest.fn(async ({ load }) => load()),
}));
jest.mock('../src/utils/autoIpBan', () => ({ recordAbuseStrikeFromRequest: jest.fn() }));

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makePipeline(execResult: any[] = []) {
  const p: any = {
    hincrby: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(execResult),
  };
  return p;
}

function buildApp() {
  jest.resetModules();
  const router = require('../src/communities/router');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/communities', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  poolMock.poolStats.mockReturnValue({ waiting: 0, total: 5, idle: 5, max: 25 });
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue(null);
  redisMock.del.mockResolvedValue(1);
  redisMock.incr.mockResolvedValue(1);
  redisMock.eval.mockResolvedValue(1);
  redisMock.sadd.mockResolvedValue(1);
  redisMock.srem.mockResolvedValue(1);
  redisMock.setex.mockResolvedValue('OK');
  redisMock.hmget.mockResolvedValue([]);
  redisMock.pipeline.mockReturnValue(makePipeline());
});

// ── incrCommunityMemberCount ─────────────────────────────────────────────────────

describe('incrCommunityMemberCount', () => {
  let incrCommunityMemberCount: (id: string) => Promise<void>;

  beforeEach(() => {
    jest.resetModules();
    incrCommunityMemberCount = require('../src/communities/communityMemberCount').incrCommunityMemberCount;
  });

  it('calls HINCRBY +1 and SADD dirty via pipeline', async () => {
    const pipeline = makePipeline([[null, 5], [null, 1]]);
    redisMock.pipeline.mockReturnValue(pipeline);

    await incrCommunityMemberCount('c-1');

    expect(pipeline.hincrby).toHaveBeenCalledWith('community:counts', 'c-1', 1);
    expect(pipeline.sadd).toHaveBeenCalledWith('community:counts:dirty', 'c-1');
    expect(pipeline.exec).toHaveBeenCalled();
    expect(metricsMock.communityCountRedisUpdateTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('records error metric and does not throw on Redis failure', async () => {
    const pipeline = makePipeline();
    pipeline.exec.mockRejectedValue(new Error('Redis ECONNREFUSED'));
    redisMock.pipeline.mockReturnValue(pipeline);

    await expect(incrCommunityMemberCount('c-1')).resolves.toBeUndefined();
    expect(metricsMock.communityCountRedisUpdateTotal.inc).toHaveBeenCalledWith({ result: 'error' });
  });
});

// ── decrCommunityMemberCount ─────────────────────────────────────────────────────

describe('decrCommunityMemberCount', () => {
  let decrCommunityMemberCount: (id: string) => Promise<void>;

  beforeEach(() => {
    jest.resetModules();
    decrCommunityMemberCount = require('../src/communities/communityMemberCount').decrCommunityMemberCount;
  });

  it('calls HINCRBY -1 and SADD dirty via pipeline', async () => {
    const pipeline = makePipeline([[null, 3], [null, 1]]);
    redisMock.pipeline.mockReturnValue(pipeline);

    await decrCommunityMemberCount('c-1');

    expect(pipeline.hincrby).toHaveBeenCalledWith('community:counts', 'c-1', -1);
    expect(pipeline.sadd).toHaveBeenCalledWith('community:counts:dirty', 'c-1');
    expect(metricsMock.communityCountRedisUpdateTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('clamps to 0 by calling HSET when HINCRBY returns negative', async () => {
    const pipeline = makePipeline([[null, -1], [null, 1]]);
    redisMock.pipeline.mockReturnValue(pipeline);
    redisMock.hset.mockResolvedValue(1);

    await decrCommunityMemberCount('c-1');

    expect(redisMock.hset).toHaveBeenCalledWith('community:counts', 'c-1', '0');
    expect(metricsMock.communityCountRedisUpdateTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('does not call HSET when result is >= 0', async () => {
    const pipeline = makePipeline([[null, 0], [null, 1]]);
    redisMock.pipeline.mockReturnValue(pipeline);

    await decrCommunityMemberCount('c-1');

    expect(redisMock.hset).not.toHaveBeenCalled();
  });

  it('records error metric and does not throw on Redis failure', async () => {
    const pipeline = makePipeline();
    pipeline.exec.mockRejectedValue(new Error('Redis gone'));
    redisMock.pipeline.mockReturnValue(pipeline);

    await expect(decrCommunityMemberCount('c-1')).resolves.toBeUndefined();
    expect(metricsMock.communityCountRedisUpdateTotal.inc).toHaveBeenCalledWith({ result: 'error' });
  });
});

// ── getCommunityMemberCountsFromRedis ───────────────────────────────────────────

describe('getCommunityMemberCountsFromRedis', () => {
  let getCommunityMemberCountsFromRedis: (ids: string[]) => Promise<Map<string, number>>;

  beforeEach(() => {
    jest.resetModules();
    getCommunityMemberCountsFromRedis =
      require('../src/communities/communityMemberCount').getCommunityMemberCountsFromRedis;
  });

  it('returns empty map for empty input without calling Redis', async () => {
    const result = await getCommunityMemberCountsFromRedis([]);

    expect(result.size).toBe(0);
    expect(redisMock.hmget).not.toHaveBeenCalled();
  });

  it('maps present keys to counts and emits hit metrics', async () => {
    redisMock.hmget.mockResolvedValue(['7', null, '3']);

    const result = await getCommunityMemberCountsFromRedis(['c1', 'c2', 'c3']);

    expect(result.get('c1')).toBe(7);
    expect(result.has('c2')).toBe(false);
    expect(result.get('c3')).toBe(3);
    expect(metricsMock.communityCountCacheTotal.inc).toHaveBeenCalledWith({ result: 'hit' });
    expect(metricsMock.communityCountCacheTotal.inc).toHaveBeenCalledWith({ result: 'miss' });
  });

  it('clamps negative Redis values to 0', async () => {
    redisMock.hmget.mockResolvedValue(['-5']);

    const result = await getCommunityMemberCountsFromRedis(['c1']);

    expect(result.get('c1')).toBe(0);
  });

  it('returns empty map (not throw) on Redis error', async () => {
    redisMock.hmget.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await getCommunityMemberCountsFromRedis(['c1']);

    expect(result.size).toBe(0);
  });
});

// ── runReconcile ────────────────────────────────────────────────────────────────

describe('runReconcile', () => {
  let runReconcile: () => Promise<void>;

  beforeEach(() => {
    jest.resetModules();
    runReconcile = require('../src/communities/communityMemberCount').runReconcile;
  });

  it('skips with reason=pressure when pool queue is at threshold', async () => {
    poolMock.poolStats.mockReturnValue({ waiting: 2 });

    await runReconcile();

    expect(metricsMock.communityCountPgReconcileSkippedTotal.inc).toHaveBeenCalledWith({ reason: 'pressure' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('skips with reason=lock when distributed lock is not acquired', async () => {
    poolMock.poolStats.mockReturnValue({ waiting: 0 });
    redisMock.set.mockResolvedValue(null); // NX returns null when key exists

    await runReconcile();

    expect(metricsMock.communityCountPgReconcileSkippedTotal.inc).toHaveBeenCalledWith({ reason: 'lock' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('skips with reason=empty when dirty set has no entries', async () => {
    poolMock.poolStats.mockReturnValue({ waiting: 0 });
    redisMock.set.mockResolvedValue('OK');
    redisMock.sscan.mockResolvedValue(['0', []]);

    await runReconcile();

    expect(metricsMock.communityCountPgReconcileSkippedTotal.inc).toHaveBeenCalledWith({ reason: 'empty' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('runs batch UPDATE and syncs Redis when dirty entries exist', async () => {
    poolMock.poolStats.mockReturnValue({ waiting: 0 });
    redisMock.set.mockResolvedValue('OK');
    redisMock.eval.mockResolvedValue(1);
    redisMock.sscan.mockResolvedValue(['0', ['c1', 'c2']]);
    poolMock.query.mockResolvedValue({
      rows: [
        { id: 'c1', member_count: 5 },
        { id: 'c2', member_count: 12 },
      ],
    });
    const pipeline = makePipeline([[null, 'OK'], [null, 'OK']]);
    redisMock.pipeline.mockReturnValue(pipeline);
    redisMock.srem.mockResolvedValue(2);

    await runReconcile();

    expect(poolMock.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE communities'),
      [['c1', 'c2']],
    );
    expect(pipeline.hset).toHaveBeenCalledWith('community:counts', 'c1', '5');
    expect(pipeline.hset).toHaveBeenCalledWith('community:counts', 'c2', '12');
    expect(redisMock.srem).toHaveBeenCalledWith('community:counts:dirty', 'c1', 'c2');
    expect(metricsMock.communityCountPgReconcileTotal.inc).toHaveBeenCalledWith({ result: 'ok' });
  });

  it('records error metric and continues on DB failure', async () => {
    poolMock.poolStats.mockReturnValue({ waiting: 0 });
    redisMock.set.mockResolvedValue('OK');
    redisMock.eval.mockResolvedValue(1);
    redisMock.sscan.mockResolvedValue(['0', ['c1']]);
    poolMock.query.mockRejectedValue(new Error('deadlock detected'));

    await expect(runReconcile()).resolves.toBeUndefined();
    expect(metricsMock.communityCountPgReconcileTotal.inc).toHaveBeenCalledWith({ result: 'error' });
  });
});

// ── Router integration: join/leave still work ───────────────────────────────────

describe('communities router — join fires Redis incr, leave fires Redis decr', () => {
  const COMMUNITY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const USER_ID = 'user-1';

  beforeEach(() => {
    redisMock.pipeline.mockReturnValue(makePipeline([[null, 3], [null, 1]]));
    redisMock.hmget.mockResolvedValue([null]); // Redis miss → DB fallback
  });

  it('POST /:id/join returns 200 and fires incrCommunityMemberCount', async () => {
    poolMock.query
      .mockResolvedValueOnce({ rows: [{ id: COMMUNITY_ID, is_public: true }] }) // resolve community
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT community_members
    poolMock.queryRead.mockResolvedValue({ rows: [] }); // listCommunityRealtimeTargets

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/communities/${COMMUNITY_ID}/join`)
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // pipeline was called for the Redis incr
    expect(redisMock.pipeline).toHaveBeenCalled();
  });

  it('POST /:id/join returns 200 without Redis incr when already a member (rowCount=0)', async () => {
    const pipelineSpy = jest.fn().mockReturnValue(makePipeline([[null, 3], [null, 1]]));
    redisMock.pipeline = pipelineSpy;

    poolMock.query
      .mockResolvedValueOnce({ rows: [{ id: COMMUNITY_ID, is_public: true }] })
      .mockResolvedValueOnce({ rowCount: 0 }); // ON CONFLICT DO NOTHING hit

    const app = buildApp();
    const res = await request(app)
      .post(`/api/v1/communities/${COMMUNITY_ID}/join`)
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    // pipeline was not called because rowCount=0 short-circuits before the incr
    expect(pipelineSpy).not.toHaveBeenCalled();
  });

  it('DELETE /:id/leave returns 200 and fires decrCommunityMemberCount', async () => {
    const pipelineSpy = jest.fn().mockReturnValue(makePipeline([[null, 2], [null, 1]]));
    redisMock.pipeline = pipelineSpy;

    poolMock.query
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE community_members
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-2' }] }); // remaining members

    const app = buildApp();
    const res = await request(app)
      .delete(`/api/v1/communities/${COMMUNITY_ID}/leave`)
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(pipelineSpy).toHaveBeenCalled();
  });
});

// ── Router: communities list overlays Redis member_count ─────────────────────────

describe('GET /communities — member_count Redis overlay', () => {
  const COMMUNITY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns Redis member_count when Redis has a value', async () => {
    poolMock.query.mockResolvedValue({
      rows: [{ id: COMMUNITY_ID, name: 'test', member_count: 1, is_public: true }],
    });
    poolMock.queryRead.mockResolvedValue({ rows: [] }); // unread counts
    redisMock.hmget.mockResolvedValue(['42']); // Redis has count=42

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    const community = res.body.communities.find((c) => c.id === COMMUNITY_ID);
    expect(community?.member_count).toBe(42);
  });

  it('falls back to DB member_count when Redis has no entry', async () => {
    poolMock.query.mockResolvedValue({
      rows: [{ id: COMMUNITY_ID, name: 'test', member_count: 7, is_public: true }],
    });
    poolMock.queryRead.mockResolvedValue({ rows: [] });
    redisMock.hmget.mockResolvedValue([null]); // Redis miss

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    const community = res.body.communities.find((c) => c.id === COMMUNITY_ID);
    expect(community?.member_count).toBe(7);
  });

  it('falls back to DB member_count when Redis throws', async () => {
    poolMock.query.mockResolvedValue({
      rows: [{ id: COMMUNITY_ID, name: 'test', member_count: 9, is_public: true }],
    });
    poolMock.queryRead.mockResolvedValue({ rows: [] });
    redisMock.hmget.mockRejectedValue(new Error('ECONNREFUSED'));

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/communities')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    const community = res.body.communities.find((c) => c.id === COMMUNITY_ID);
    expect(community?.member_count).toBe(9);
  });
});
