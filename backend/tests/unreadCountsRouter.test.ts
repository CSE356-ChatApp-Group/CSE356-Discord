const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';

jest.mock('../src/db/pool', () => ({
  queryRead: jest.fn(),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: userId };
    next();
  },
}));

const pool = require('../src/db/pool') as {
  queryRead: jest.Mock;
};

function requestUnreadCounts() {
  const router = require('../src/messages/unreadCountsRouter');

  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      method: 'GET',
      url: '/',
      originalUrl: '/api/v1/unread-counts',
      path: '/',
      headers: {},
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        this.body = body;
        resolve({ statusCode: this.statusCode, body });
        return this;
      },
      setHeader: jest.fn(),
      getHeader: jest.fn(),
      end: jest.fn(),
    };
    router.handle(req, res, reject);
  });
}

describe('GET /unread-counts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.queryRead
      .mockResolvedValueOnce({
        rows: [
          {
            type: 'channel',
            channel_id: channelId,
            conversation_id: channelId,
            count: 137,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            type: 'conversation',
            channel_id: null,
            conversation_id: conversationId,
            count: 2,
          },
        ],
      });
  });

  it('returns aggregate unread counts using schema-compatible queries', async () => {
    const res = await requestUnreadCounts();

    expect(res.statusCode).toBe(200);
    expect(res.body.unreadCounts).toEqual([
      {
        conversationId: channelId,
        conversation_id: channelId,
        channelId,
        channel_id: channelId,
        type: 'channel',
        count: 137,
      },
      {
        conversationId: conversationId,
        conversation_id: conversationId,
        type: 'conversation',
        count: 2,
      },
    ]);

    const queryTexts = pool.queryRead.mock.calls.map(([arg]) => arg.text).join('\n');
    expect(queryTexts).not.toContain('LIMIT 100');
    expect(queryTexts).not.toContain('last_read_message_created_at');
    expect(pool.queryRead).toHaveBeenCalledWith(
      expect.objectContaining({ values: [userId] }),
    );
  });
});
