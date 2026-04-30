const userId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';

jest.mock('../src/db/pool', () => ({
  queryRead: jest.fn(),
  poolStats: jest.fn(() => ({ waiting: 0 })),
}));

jest.mock('../src/middleware/authenticate', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: req.headers?.['x-test-user-id'] || userId };
    next();
  },
}));

const pool = require('../src/db/pool') as {
  queryRead: jest.Mock;
  poolStats: jest.Mock;
};

function requestUnreadCounts(testUserId?: string) {
  const router = require('../src/messages/unreadCountsRouter');

  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const req: any = {
      method: 'GET',
      url: '/',
      originalUrl: '/api/v1/unread-counts',
      path: '/',
      headers: testUserId ? { 'x-test-user-id': testUserId } : {},
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
    pool.poolStats.mockReturnValue({ waiting: 0 });
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
    expect(queryTexts).toContain('rs.last_read_message_created_at');
    expect(queryTexts).toContain('rs.last_read_message_created_at IS NULL');
    expect(pool.queryRead).toHaveBeenCalledWith(
      expect.objectContaining({ values: [userId] }),
    );
  });

  it('falls back to empty counts when either unread query times out', async () => {
    pool.queryRead.mockReset();
    pool.queryRead
      .mockRejectedValueOnce(Object.assign(new Error('Query read timeout'), { code: '57014' }))
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

    const res = await requestUnreadCounts();

    expect(res.statusCode).toBe(200);
    expect(res.body.unreadCounts).toEqual([
      {
        conversationId: conversationId,
        conversation_id: conversationId,
        type: 'conversation',
        count: 2,
      },
    ]);
  });

  it('propagates non-timeout errors to the global error handler', async () => {
    pool.queryRead.mockReset();
    pool.queryRead.mockRejectedValueOnce(new Error('database exploded'));

    await expect(requestUnreadCounts()).rejects.toThrow('database exploded');
  });

  it('sheds unread-counts queries under inflight pressure with a 200 empty payload', async () => {
    pool.queryRead.mockReset();

    let releaseBlockedRead;
    const blockedRead = new Promise((resolve) => {
      releaseBlockedRead = resolve;
    });
    pool.queryRead.mockImplementation(() => blockedRead);

    const inFlightRequests = Array.from({ length: 48 }, (_unused, i) =>
      requestUnreadCounts(`user-${i + 1}`),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const shedRes = await requestUnreadCounts('user-over-cap');
    expect(shedRes.statusCode).toBe(200);
    expect(shedRes.body).toEqual({ unreadCounts: [], counts: [], data: [] });

    releaseBlockedRead({ rows: [] });
    await Promise.all(inFlightRequests);
  });

  it('sheds unread-counts queries when pg pool waiting is above threshold', async () => {
    pool.queryRead.mockReset();
    pool.poolStats.mockReturnValue({ waiting: 8 });

    const res = await requestUnreadCounts();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ unreadCounts: [], counts: [], data: [] });
    expect(pool.queryRead).not.toHaveBeenCalled();
  });

  it('coalesces concurrent unread-count requests for the same user', async () => {
    pool.queryRead.mockReset();
    pool.poolStats.mockReturnValue({ waiting: 0 });

    let releaseFirstRead;
    const firstRead = new Promise((resolve) => {
      releaseFirstRead = resolve;
    });
    pool.queryRead
      .mockImplementationOnce(() => firstRead)
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

    const req1 = requestUnreadCounts();
    const req2 = requestUnreadCounts();
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.queryRead).toHaveBeenCalledTimes(1);
    releaseFirstRead({ rows: [] });

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(pool.queryRead).toHaveBeenCalledTimes(2);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.body).toEqual(res2.body);
  });
});
