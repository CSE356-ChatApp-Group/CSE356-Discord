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

jest.mock('../src/presence/service', () => ({}));
jest.mock('../src/websocket/fanout', () => ({}));
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
  queryRead: jest.Mock;
};
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  eval: jest.Mock;
};

function buildApp() {
  const router = require('../src/communities/router');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/communities', router);
  return app;
}

describe('GET /communities resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.setex.mockResolvedValue('OK');
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
  });

  it('serves last-good cached payload on transient main-list query failure', async () => {
    const stalePayload = {
      communities: [{ id: 'c-1', name: 'stale community' }],
    };

    redis.get.mockImplementation(async (key: string) => {
      if (key === 'communities:list:public_version') return '0';
      if (key === 'communities:list:user-1:v0') return null;
      if (key === 'communities:list:last_good:user-1') return JSON.stringify(stalePayload);
      return null;
    });

    pool.queryRead.mockRejectedValue(new Error('query read timeout'));

    const app = buildApp();
    const res = await request(app).get('/api/v1/communities');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stalePayload);
  });

  it('returns 503 (not 500) on transient main-list failure when no stale cache exists', async () => {
    redis.get.mockImplementation(async (key: string) => {
      if (key === 'communities:list:public_version') return '0';
      return null;
    });

    pool.queryRead.mockRejectedValue(new Error('timeout exceeded when trying to connect'));

    const app = buildApp();
    const res = await request(app).get('/api/v1/communities');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.error).toMatch(/briefly unavailable/i);
  });

  it('uses bounded timeout for the main communities query and refreshes last-good cache on success', async () => {
    redis.get.mockImplementation(async (key: string) => {
      if (key === 'communities:list:public_version') return '0';
      if (key === 'communities:list:user-1:v0') return null;
      return null;
    });

    pool.queryRead.mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await request(app).get('/api/v1/communities');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ communities: [] });
    expect(pool.queryRead).toHaveBeenCalledWith(expect.objectContaining({
      query_timeout: 2500,
    }));
    expect(redis.setex).toHaveBeenCalledWith(
      'communities:list:last_good:user-1',
      900,
      JSON.stringify({ communities: [] }),
    );
  });
});
