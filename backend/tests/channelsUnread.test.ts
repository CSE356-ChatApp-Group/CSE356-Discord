import express from 'express';
import request from 'supertest';

const userId = '00000000-0000-4000-8000-000000000001';
const communityId = '00000000-0000-4000-8000-000000000002';
const channelId = '00000000-0000-4000-8000-000000000003';

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  queryRead: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  mget: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  pipeline: jest.fn(() => ({
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: userId };
    next();
  },
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../src/messages/sideEffects', () => ({ enqueueFanoutJob: jest.fn() }));
jest.mock('../src/websocket/fanout', () => ({ publish: jest.fn() }));
jest.mock('../src/websocket/userFeed', () => ({ publishUserFeedTargets: jest.fn() }));
jest.mock('../src/websocket/server', () => ({
  invalidateWsAclCache: jest.fn(),
  invalidateWsBootstrapCaches: jest.fn(),
  evictUnauthorizedChannelSubscribers: jest.fn(),
}));
jest.mock('../src/messages/channelRealtimeFanout', () => ({
  invalidateChannelUserFanoutTargetsCache: jest.fn(),
}));
jest.mock('../src/messages/channelAccessCache', () => ({
  raceChannelAccess: jest.fn(),
}));
jest.mock('../src/messages/repointLastMessage', () => ({
  getChannelLastMessageMetaMapFromRedis: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
}));
jest.mock('../src/utils/distributedSingleflight', () => ({
  staleCacheKey: jest.fn((key: string) => `stale:${key}`),
  getJsonCache: jest.fn().mockResolvedValue(null),
  setJsonCacheWithStale: jest.fn().mockResolvedValue(undefined),
  withDistributedSingleflight: jest.fn(async ({ load }) => load()),
}));

const pool = require('../src/db/pool') as {
  query: jest.Mock;
  queryRead: jest.Mock;
};
const redis = require('../src/db/redis') as {
  mget: jest.Mock;
};

function buildApp() {
  const router = require('../src/channels/router');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels', router);
  return app;
}

describe('GET /channels unread_message_count', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    redis.mget.mockResolvedValue([null]);
    pool.queryRead.mockImplementation(async (sqlOrConfig: any) => {
      if (typeof sqlOrConfig === 'string') {
        return {
          rows: [
            {
              id: channelId,
              community_id: communityId,
              name: 'general',
              description: null,
              is_private: false,
              type: 'text',
              position: 0,
              created_by: userId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              can_access: true,
              last_message_id: '00000000-0000-4000-8000-000000000004',
              last_message_author_id: '00000000-0000-4000-8000-000000000005',
              last_message_at: new Date().toISOString(),
              my_last_read_message_id: null,
              my_last_read_at: null,
            },
          ],
        };
      }

      expect(sqlOrConfig.text).toContain('requested_channels');
      expect(sqlOrConfig.text).toContain('LIMIT 100');
      expect(sqlOrConfig.values).toEqual([userId, [channelId]]);
      return { rows: [{ channel_id: channelId, unread_count: 3 }] };
    });
  });

  it('uses an exact batch fallback when Redis unread counters are missing', async () => {
    const app = buildApp();

    const res = await request(app).get(`/api/v1/channels?communityId=${communityId}`);

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].unread_message_count).toBe(3);
  });
});
