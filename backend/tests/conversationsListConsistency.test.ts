import express from 'express';
import request from 'supertest';

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../src/db/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  eval: jest.fn(),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('../src/presence/service', () => ({
  invalidatePresenceFanoutTargetsBulk: jest.fn(),
}));

jest.mock('../src/websocket/server', () => ({
  invalidateWsBootstrapCaches: jest.fn(),
}));

jest.mock('../src/websocket/fanout', () => {
  const fanoutPublishMock = jest.fn();
  const fanoutPublishBatchMock = jest.fn(async (entries) => {
    for (const e of entries) await fanoutPublishMock(e.channel, e.payload);
  });
  return { publish: fanoutPublishMock, publishBatch: fanoutPublishBatchMock };
});

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(),
  splitUserTargets: jest.fn((targets: string[]) => ({
    userIds: [],
    passthroughTargets: targets,
  })),
}));

jest.mock('../src/messages/messageCacheBust', () => ({
  bustConversationMessagesCache: jest.fn(),
}));

jest.mock('../src/messages/conversationFanoutTargets', () => ({
  invalidateConversationFanoutTargetsCache: jest.fn(),
}));

jest.mock('../src/messages/realtimePayload', () => ({
  wrapFanoutPayload: jest.fn((_event: string, data: unknown) => data),
}));

jest.mock('../src/utils/endpointCacheMetrics', () => ({
  recordEndpointListCache: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
}));

const pool = require('../src/db/pool') as {
  query: jest.Mock;
};
const redis = require('../src/db/redis') as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
};

function buildApp() {
  const router = require('../src/messages/conversationsRouter');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/conversations', router);
  return app;
}

describe('conversation list/read consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.eval.mockResolvedValue(1);
  });

  it('reads the conversation list from primary on cache miss', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'conv-1',
        name: null,
        created_by: 'user-1',
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:00.000Z',
        is_group: false,
        last_message_id: 'msg-1',
        last_message_author_id: 'user-1',
        last_message_at: '2026-04-24T00:00:00.000Z',
        my_last_read_message_id: null,
        my_last_read_at: null,
        other_last_read_message_id: null,
        other_last_read_at: null,
        participants: [{ id: 'user-2', username: 'other', displayName: 'Other', avatarUrl: null }],
      }],
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/conversations');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].id).toBe('conv-1');
  });

  it('reads a single conversation from primary', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'conv-2',
        name: 'Group',
        created_by: 'user-1',
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:00.000Z',
        is_group: true,
        last_message_id: null,
        last_message_author_id: null,
        last_message_at: null,
        participants: [{ id: 'user-2', username: 'other', displayName: 'Other' }],
      }],
    });

    const app = buildApp();
    const res = await request(app).get('/api/v1/conversations/conv-2');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.body.conversation.id).toBe('conv-2');
  });
});
