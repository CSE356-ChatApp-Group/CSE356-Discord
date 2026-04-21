jest.mock('../src/db/pool', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  child: jest.fn(() => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() })),
}));

jest.mock('../src/utils/overload', () => ({
  getStage: jest.fn(() => 0),
}));

const { withTransaction } = require('../src/db/pool') as { withTransaction: jest.Mock };
const overload = require('../src/utils/overload') as { getStage: jest.Mock };
const { search } = require('../src/search/client') as {
  search: (q: string, opts?: Record<string, any>) => Promise<{ hits: any[] }>;
};

describe('search overload behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
  });

  it('still allows trigram fallback for community-scoped searches at stage 1', async () => {
    overload.getStage.mockReturnValue(1);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})  // SET LOCAL statement_timeout
          .mockResolvedValueOnce({})  // SET LOCAL work_mem
          .mockResolvedValueOnce({ rows: [] })  // FTS query (no results)
          .mockResolvedValueOnce({
            rows: [{
              id: 'msg-1',
              content: 'more just about the shared topic',
              authorId: 'user-1',
              authorDisplayName: 'User One',
              channelId: 'channel-1',
              conversationId: null,
              communityId: 'community-1',
              channelName: 'general',
              createdAt: '2026-04-21T16:35:23.000Z',
            }],
          }),
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('more just about', {
      communityId: 'community-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('msg-1');
    expect(recordedClient?.query).toHaveBeenCalledTimes(4);
    expect(recordedClient?.query).toHaveBeenNthCalledWith(1, 'SET LOCAL statement_timeout = 3000');
  });

  it('still allows trigram fallback for channel-scoped searches at stage 1', async () => {
    overload.getStage.mockReturnValue(1);

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})  // SET LOCAL statement_timeout
          .mockResolvedValueOnce({})  // SET LOCAL work_mem
          .mockResolvedValueOnce({ rows: [] })  // FTS query (no results)
          .mockResolvedValueOnce({
            rows: [{
              id: 'msg-1',
              content: 'hello there',
              authorId: 'user-1',
              authorDisplayName: 'User One',
              channelId: 'channel-1',
              conversationId: null,
              communityId: 'community-1',
              channelName: 'general',
              createdAt: '2026-04-17T18:35:23.000Z',
              highlight: 'hello there',
            }],
          }),
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('hel', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('msg-1');
    expect(recordedClient?.query).toHaveBeenCalledTimes(4);
  });

  it('caps channel-scoped trigram fallback to newest scoped candidates', async () => {
    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] }),
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('the', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    const trigramSql = recordedClient?.query.mock.calls[3]?.[0] ?? '';
    expect(trigramSql).toContain('trigram_scope_candidates');
    expect(trigramSql).toContain('messages.channel_id');
    expect(trigramSql).toContain('ORDER BY created_at DESC');
  });

  it('builds both FTS and trigram queries to require every search term', async () => {
    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})  // SET LOCAL statement_timeout
          .mockResolvedValueOnce({})  // SET LOCAL work_mem
          .mockResolvedValueOnce({ rows: [] })  // FTS query (no results)
          .mockResolvedValueOnce({ rows: [] }), // trigram query (no results)
      };
      recordedClient = client;
      return run(client);
    });

    const result = await search('games that have', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    const ftsSql = recordedClient?.query.mock.calls[2]?.[0] ?? '';
    const ftsParams = recordedClient?.query.mock.calls[2]?.[1] ?? [];
    const trigramSql = recordedClient?.query.mock.calls[3]?.[0] ?? '';
    const trigramParams = recordedClient?.query.mock.calls[3]?.[1] ?? [];

    expect((ftsSql.match(/coalesce\(m\.content, ''\) ILIKE/g) || []).length).toBe(3);
    expect((trigramSql.match(/coalesce\(m\.content, ''\) ILIKE/g) || []).length).toBe(3);
    expect(ftsParams).toEqual(expect.arrayContaining(['%games%', '%that%', '%have%']));
    expect(trigramParams).toEqual(expect.arrayContaining(['%games%', '%that%', '%have%']));
  });

  it('does not retry trigram fallback after a scoped access denial', async () => {
    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [{ __scopeAccess: false }] }),
      };
      recordedClient = client;
      return run(client);
    });

    await expect(
      search('private marker', {
        channelId: 'channel-1',
        userId: 'user-2',
        limit: 20,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(recordedClient?.query).toHaveBeenCalledTimes(3);
  });
});
