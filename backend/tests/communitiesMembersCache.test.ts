import express from 'express';
import request from 'supertest';

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  queryRead: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  eval: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('../src/presence/service', () => ({
  getBulkPresenceDetails: jest.fn(),
  invalidatePresenceFanoutTargets: jest.fn(),
}));
jest.mock('../src/websocket/fanout', () => ({
  publish: jest.fn(),
}));
jest.mock('../src/websocket/userFeed', () => ({ publishUserFeedTargets: jest.fn() }));
jest.mock('../src/websocket/server', () => ({
  invalidateWsBootstrapCache: jest.fn(),
  invalidateWsAclCache: jest.fn(),
}));
jest.mock('../src/messages/channelRealtimeFanout', () => ({
  invalidateCommunityChannelUserFanoutTargetsCache: jest.fn(),
}));
jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
  recordEndpointListCacheBypass: jest.fn(),
}));

const pool = require('../src/db/pool') as {
  query: jest.Mock;
  queryRead: jest.Mock;
};
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  incr: jest.Mock;
  eval: jest.Mock;
};
const presenceService = require('../src/presence/service') as {
  getBulkPresenceDetails: jest.Mock;
};
const fanout = require('../src/websocket/fanout') as {
  publish: jest.Mock;
};

function buildApp() {
  const router = require('../src/communities/router');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/communities', router);
  return app;
}

describe('community members roster caching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.setex.mockResolvedValue('OK');
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.incr.mockResolvedValue(1);
    redis.eval.mockResolvedValue(1);
    fanout.publish.mockResolvedValue(1);
    presenceService.getBulkPresenceDetails.mockResolvedValue({});
  });

  it('caches roster on miss and overlays presence from Redis', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    pool.queryRead
      .mockResolvedValueOnce({ rows: [{ my_role: 'member' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'u-1',
            username: 'alice',
            display_name: 'Alice',
            avatar_url: null,
            role: 'member',
            joined_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    presenceService.getBulkPresenceDetails.mockResolvedValue({
      'u-1': { status: 'away', awayMessage: 'brb' },
    });

    const app = buildApp();
    const res = await request(app).get(`/api/v1/communities/${communityId}/members`);

    expect(res.status).toBe(200);
    expect(pool.queryRead).toHaveBeenCalledTimes(2);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith(
      `community:${communityId}:members`,
      30,
      expect.any(String),
    );
    expect(presenceService.getBulkPresenceDetails).toHaveBeenCalledWith(['u-1']);
    expect(res.body.members[0]).toMatchObject({
      id: 'u-1',
      status: 'away',
      away_message: 'brb',
    });
  });

  it('uses cached roster and avoids roster DB query while still enforcing access check', async () => {
    const communityId = '22222222-2222-4222-8222-222222222222';
    redis.get.mockResolvedValue(
      JSON.stringify([
        {
          id: 'u-2',
          username: 'bob',
          display_name: 'Bob',
          avatar_url: null,
          role: 'admin',
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    pool.queryRead.mockResolvedValueOnce({ rows: [{ my_role: 'member' }] });
    presenceService.getBulkPresenceDetails.mockResolvedValue({
      'u-2': { status: 'online', awayMessage: null },
    });

    const app = buildApp();
    const res = await request(app).get(`/api/v1/communities/${communityId}/members`);

    expect(res.status).toBe(200);
    expect(pool.queryRead).toHaveBeenCalledTimes(1);
    expect(redis.setex).not.toHaveBeenCalled();
    expect(presenceService.getBulkPresenceDetails).toHaveBeenCalledWith(['u-2']);
    expect(res.body.members[0]).toMatchObject({
      id: 'u-2',
      status: 'online',
      away_message: null,
    });
  });

  it('invalidates members cache on community delete', async () => {
    const communityId = '33333333-3333-4333-8333-333333333333';

    pool.queryRead
      .mockResolvedValueOnce({ rows: [] });

    pool.query
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // loadMembership
      .mockResolvedValueOnce({
        rows: [{ id: communityId, owner_id: 'user-1', is_public: false }],
      })
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-1' }, { user_id: 'user-2' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // delete messages
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // delete community

    redis.get.mockImplementation(async (key: string) => {
      if (key === 'communities:list:public_version') return '0';
      return null;
    });

    const app = buildApp();
    const res = await request(app).delete(`/api/v1/communities/${communityId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(redis.del).toHaveBeenCalledWith(`community:${communityId}:members`);
  });
});
