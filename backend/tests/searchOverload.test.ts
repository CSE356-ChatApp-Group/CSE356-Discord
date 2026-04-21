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
  const originalScopedMinLen = process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED;

  beforeEach(() => {
    jest.clearAllMocks();
    overload.getStage.mockReturnValue(0);
    delete process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED;
  });

  afterAll(() => {
    if (originalScopedMinLen === undefined) delete process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED;
    else process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED = originalScopedMinLen;
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

  it('caps tiny channel-scoped fallback to newest scoped candidates', async () => {
    let firstClient: { query: jest.Mock } | null = null;
    let secondClient: { query: jest.Mock } | null = null;
    withTransaction
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        firstClient = client;
        return run(client);
      })
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] }),
        };
        secondClient = client;
        return run(client);
      });

    const result = await search('be', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    const trigramSql = firstClient?.query.mock.calls[3]?.[0] ?? '';
    const trigramParams = firstClient?.query.mock.calls[3]?.[1] ?? [];
    expect(trigramSql).toContain('trigram_scope_candidates');
    expect(trigramSql).toContain('messages.channel_id');
    expect(trigramSql).toContain('ORDER BY created_at DESC');
    expect(trigramSql).toContain('messages.channel_id = $3');
    expect(trigramSql).toContain("ILIKE $4 ESCAPE '\\'");
    expect(trigramParams).toHaveLength(6);
    expect(secondClient?.query).toHaveBeenCalledTimes(3);
  });

  it('still falls back for short channel-scoped words when scoped trigram is disabled by config', async () => {
    process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED = '999';

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [{
              id: 'msg-1',
              content: 'hi ed be',
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

    const result = await search('be', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].content).toBe('hi ed be');
    expect(result.hits[0]._formatted.content).toContain('<em>be</em>');
    expect(recordedClient?.query).toHaveBeenCalledTimes(4);
  });

  it('uses full scoped trigram search for 3+ character filler words instead of only the newest candidate window', async () => {
    process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED = '999';

    let recordedClient: { query: jest.Mock } | null = null;
    withTransaction.mockImplementation(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
      const client = {
        query: jest.fn()
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({
            rows: [{
              id: 'msg-1',
              content: 'what are the odds',
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

    const result = await search('the', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]._formatted.content).toContain('<em>the</em>');
    const trigramSql = recordedClient?.query.mock.calls[3]?.[0] ?? '';
    expect(trigramSql).not.toContain('trigram_scope_candidates');
    expect(trigramSql).toContain('m.content IS NOT NULL');
    expect(trigramSql).toContain('m.content ILIKE');
    expect(trigramSql).toContain('m.channel_id = $3');
  });

  it('builds both FTS and trigram queries to require every search term', async () => {
    let firstClient: { query: jest.Mock } | null = null;
    let secondClient: { query: jest.Mock } | null = null;
    withTransaction
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})  // SET LOCAL statement_timeout
            .mockResolvedValueOnce({})  // SET LOCAL work_mem
            .mockResolvedValueOnce({ rows: [] })  // FTS query (no results)
            .mockResolvedValueOnce({ rows: [] }), // trigram query (no results)
        };
        firstClient = client;
        return run(client);
      })
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] }),
        };
        secondClient = client;
        return run(client);
      });

    const result = await search('games that have', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    const ftsSql = firstClient?.query.mock.calls[2]?.[0] ?? '';
    const ftsParams = firstClient?.query.mock.calls[2]?.[1] ?? [];
    const trigramSql = firstClient?.query.mock.calls[3]?.[0] ?? '';
    const trigramParams = firstClient?.query.mock.calls[3]?.[1] ?? [];

    expect((ftsSql.match(/m\.content IS NOT NULL AND m\.content ~\*/g) || []).length).toBe(3);
    expect((trigramSql.match(/m\.content IS NOT NULL AND m\.content ~\*/g) || []).length).toBe(2);
    expect(trigramSql).toContain('m.content IS NOT NULL');
    expect(trigramSql).toContain('m.content ILIKE');
    expect(ftsParams).toEqual(expect.arrayContaining([
      '(^|[^[:alnum:]])games([^[:alnum:]]|$)',
      '(^|[^[:alnum:]])that([^[:alnum:]]|$)',
      '(^|[^[:alnum:]])have([^[:alnum:]]|$)',
    ]));
    expect(trigramParams).toEqual(expect.arrayContaining([
      '%games%',
      '(^|[^[:alnum:]])that([^[:alnum:]]|$)',
      '(^|[^[:alnum:]])have([^[:alnum:]]|$)',
    ]));
    expect(secondClient?.query).toHaveBeenCalledTimes(3);
  });

  it('uses word-boundary matching for multi-term all-word filters so short words do not match inside larger words', async () => {
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

    await search('a lazy', {
      channelId: 'channel-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    const ftsSql = recordedClient?.query.mock.calls[2]?.[0] ?? '';
    const ftsParams = recordedClient?.query.mock.calls[2]?.[1] ?? [];
    expect(ftsSql).toContain('m.content IS NOT NULL AND m.content ~*');
    expect(ftsParams).toEqual(expect.arrayContaining([
      '(^|[^[:alnum:]])a([^[:alnum:]]|$)',
      '(^|[^[:alnum:]])lazy([^[:alnum:]]|$)',
    ]));
  });

  it('retries fallback separately when the FTS phase times out', async () => {
    let firstClient: { query: jest.Mock } | null = null;
    let secondClient: { query: jest.Mock } | null = null;

    withTransaction
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' })),
        };
        firstClient = client;
        return run(client);
      })
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
              rows: [{
                id: 'msg-1',
                content: 'probably some other message',
                authorId: 'user-1',
                authorDisplayName: 'User One',
                channelId: null,
                conversationId: 'conv-1',
                communityId: null,
                channelName: null,
                createdAt: '2026-04-21T16:35:23.000Z',
              }],
            }),
        };
        secondClient = client;
        return run(client);
      });

    const result = await search('probably some other', {
      conversationId: 'conv-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(firstClient?.query).toHaveBeenCalledTimes(3);
    expect(secondClient?.query).toHaveBeenCalledTimes(3);
    expect(withTransaction).toHaveBeenCalledTimes(2);
  });

  it('limits community-scoped candidates inside the requested community instead of globally', async () => {
    let firstClient: { query: jest.Mock } | null = null;
    let secondClient: { query: jest.Mock } | null = null;
    withTransaction
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        firstClient = client;
        return run(client);
      })
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] }),
        };
        secondClient = client;
        return run(client);
      });

    const result = await search('hi', {
      communityId: 'community-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toEqual([]);
    const ftsSql = firstClient?.query.mock.calls[2]?.[0] ?? '';
    const trigramSql = firstClient?.query.mock.calls[3]?.[0] ?? '';
    expect(ftsSql).toContain('JOIN channels ch_scope');
    expect(ftsSql).toContain('ch_scope.community_id = $2');
    expect(trigramSql).toContain('JOIN channels ch_scope');
    expect(trigramSql).toContain('ch_scope.community_id = $1');
    expect(secondClient?.query).toHaveBeenCalledTimes(3);
  });

  it('retries an exhaustive scoped primary scan when the normal search returns an empty result set', async () => {
    let firstClient: { query: jest.Mock } | null = null;
    let secondClient: { query: jest.Mock } | null = null;

    withTransaction
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        firstClient = client;
        return run(client);
      })
      .mockImplementationOnce(async (run: (client: { query: jest.Mock }) => Promise<any>) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
              rows: [{
                id: 'msg-1',
                content: 'only this server',
                authorId: 'user-1',
                authorDisplayName: 'User One',
                channelId: null,
                conversationId: 'conv-1',
                communityId: null,
                channelName: null,
                createdAt: '2026-04-21T16:35:23.000Z',
              }],
            }),
        };
        secondClient = client;
        return run(client);
      });

    const result = await search('only this server', {
      conversationId: 'conv-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].content).toBe('only this server');
    expect(firstClient?.query).toHaveBeenCalledTimes(4);
    expect(secondClient?.query).toHaveBeenCalledTimes(3);
    expect(withTransaction).toHaveBeenCalledTimes(2);
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
