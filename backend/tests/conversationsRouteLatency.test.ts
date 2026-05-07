import express from 'express';
import request from 'supertest';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SIDE_EFFECT_DELAY_MS = 120;

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: '11111111-1111-4111-8111-111111111111' };
    next();
  },
}));

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

jest.mock('../src/presence/service', () => ({
  invalidatePresenceFanoutTargetsBulk: jest.fn(async () => undefined),
}));

jest.mock('../src/websocket/server', () => ({
  invalidateWsBootstrapCache: jest.fn(async () => undefined),
  invalidateWsBootstrapCaches: jest.fn(async () => undefined),
}));

jest.mock('../src/messages/fanout/conversationFanoutTargets', () => ({
  invalidateConversationFanoutTargetsCache: jest.fn(async () => undefined),
}));

jest.mock('../src/messages/messageCacheBust', () => ({
  bustConversationMessagesCache: jest.fn(async () => undefined),
}));

jest.mock('../src/websocket/userFeed', () => ({
  publishUserFeedTargets: jest.fn(async () => {
    await sleep(SIDE_EFFECT_DELAY_MS);
  }),
}));

jest.mock('../src/messages/conversationsRouterPublish', () => ({
  publishConversationEvents: jest.fn(async () => {
    await sleep(SIDE_EFFECT_DELAY_MS);
  }),
  publishConversationInviteNotifications: jest.fn(async () => {
    await sleep(SIDE_EFFECT_DELAY_MS);
  }),
  scheduleGroupDmInviteRetry: jest.fn(),
}));

jest.mock('../src/messages/conversationsRouterRepo', () => ({
  CONVERSATION_FIELDS: 'c.id',
  CONVERSATION_LIST_FIELDS: 'c.id',
  getParticipantInputs: (body: Record<string, unknown> = {}) => (
    Array.isArray(body.participantIds) ? body.participantIds : []
  ),
  getActiveParticipantIds: jest
    .fn()
    .mockResolvedValueOnce(['11111111-1111-4111-8111-111111111111'])
    .mockResolvedValueOnce([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]),
  loadConversationWithParticipants: jest.fn(async (_client, conversationId: string) => ({
    id: conversationId,
    is_group: true,
    participants: [
      { id: '11111111-1111-4111-8111-111111111111' },
      { id: '22222222-2222-4222-8222-222222222222' },
    ],
  })),
  resolveParticipantIds: jest.fn(async () => ['22222222-2222-4222-8222-222222222222']),
  getUserDisplayName: jest.fn(async () => 'User'),
  getUserDisplayNamesMap: jest.fn(async () => new Map([
    ['22222222-2222-4222-8222-222222222222', 'Invited User'],
  ])),
  insertConversationParticipantsBatch: jest.fn(async () => undefined),
  upsertConversationParticipantsBatch: jest.fn(async () => undefined),
  createSystemMessage: jest.fn(async () => null),
  createSystemMessagesBatch: jest.fn(async () => ([
    { id: 'msg-a', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Invited User joined the group.' },
    { id: 'msg-b', conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Invited User joined the group.' },
  ])),
  sortDirectPairUserIds: jest.fn((a: string, b: string) => [a, b].sort()),
  lockDirectConversationPair: jest.fn(async () => undefined),
  getDirectConversationPairConversationId: jest.fn(async () => null),
  findLegacyDirectConversationId: jest.fn(async () => null),
  upsertDirectConversationPair: jest.fn(async () => undefined),
  getCachedDmPairConversationId: jest.fn(async () => null),
  cacheDmPairConversationId: jest.fn(async () => undefined),
}));

const { getClient } = require('../src/db/pool') as {
  getClient: jest.Mock;
};
const {
  publishConversationInviteNotifications,
} = require('../src/messages/conversationsRouterPublish') as {
  publishConversationInviteNotifications: jest.Mock;
};
const { publishUserFeedTargets } = require('../src/websocket/userFeed') as {
  publishUserFeedTargets: jest.Mock;
};

function buildApp() {
  const router = require('../src/messages/conversationsRouter');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/conversations', router);
  return app;
}

describe('conversations route side-effect latency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps invite latency bounded by parallel side effects', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ is_group: true, is_participant: true }] }) // conversation state
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    getClient.mockResolvedValue(client);

    const app = buildApp();
    const startedAt = Date.now();
    const res = await request(app)
      .post('/api/v1/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invite')
      .set('Authorization', 'Bearer token')
      .send({ participantIds: ['22222222-2222-4222-8222-222222222222'] });
    const elapsedMs = Date.now() - startedAt;
    // Keep a concrete measurement in test logs for before/after tuning work.
    console.info(`[latency-test] invite elapsedMs=${elapsedMs}`);

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(SIDE_EFFECT_DELAY_MS);
    await sleep(SIDE_EFFECT_DELAY_MS * 3);
    expect(publishConversationInviteNotifications).toHaveBeenCalled();
  });

  it('keeps conversation create latency bounded by parallel subscribe+invite', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            name: null,
            created_by: '11111111-1111-4111-8111-111111111111',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_group: false,
            last_message_id: null,
            last_message_author_id: null,
            last_message_at: null,
          }],
        }) // INSERT conversations
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    getClient.mockResolvedValue(client);

    const app = buildApp();
    const startedAt = Date.now();
    const res = await request(app)
      .post('/api/v1/conversations')
      .set('Authorization', 'Bearer token')
      .send({ participantIds: ['22222222-2222-4222-8222-222222222222'] });
    const elapsedMs = Date.now() - startedAt;
    console.info(`[latency-test] create elapsedMs=${elapsedMs}`);

    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(SIDE_EFFECT_DELAY_MS);
    await sleep(SIDE_EFFECT_DELAY_MS * 2);
    expect(publishUserFeedTargets).toHaveBeenCalled();
  });
});
