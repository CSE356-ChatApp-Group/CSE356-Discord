describe('OpenSearch execution', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('builds community-scoped query with author/before/after filters and newest-first sort', () => {
    jest.resetModules();
    const { buildOpenSearchQuery } = require('../src/search/opensearchExecution');
    const body = buildOpenSearchQuery('hello world', {
      communityId: 'c1',
      authorId: 'a1',
      after: '2026-01-01T00:00:00.000Z',
      before: '2026-01-02T00:00:00.000Z',
    });
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { communityId: 'c1' } },
        { term: { authorId: 'a1' } },
        expect.objectContaining({ range: { createdAt: expect.any(Object) } }),
      ]),
    );
    expect(body.sort).toEqual([{ createdAt: { order: 'desc' } }, { id: { order: 'desc' } }]);
  });

  it('builds conversation-scoped query', () => {
    jest.resetModules();
    const { buildOpenSearchQuery } = require('../src/search/opensearchExecution');
    const body = buildOpenSearchQuery('dm words', { conversationId: 'conv-1' });
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([{ term: { conversationId: 'conv-1' } }]),
    );
  });

  it('uses bounded candidate size, id-only source, and strict match query (no fuzzy/wildcard/prefix)', () => {
    jest.resetModules();
    process.env.OPENSEARCH_MAX_CANDIDATES = '5000'; // clamps to 2000
    const { buildOpenSearchQuery } = require('../src/search/opensearchExecution');
    const body = buildOpenSearchQuery('strict terms', { communityId: 'c1' });
    expect(body.size).toBe(2000);
    expect(body._source).toEqual(['id']);
    expect(body.query.bool.must).toEqual([
      { match: { content: { query: 'strict terms', operator: 'and' } } },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('wildcard');
    expect(serialized).not.toContain('prefix');
    expect(serialized).not.toContain('fuzzy');
  });

  it('rechecks through Postgres and drops stale/deleted rows, preserving latest content', async () => {
    jest.resetModules();
    jest.doMock('../src/search/opensearchClient', () => ({
      OPENSEARCH_INDEX_MESSAGES: 'messages_v1',
      opensearchFetch: jest.fn().mockResolvedValue({
        hits: { hits: [{ _id: 'm1' }, { _id: 'm2' }, { _id: 'm3' }], total: { value: 3 } },
      }),
    }));
    jest.doMock('../src/search/searchExecution', () => ({
      runSearchQuery: jest.fn(),
      runSearchReadOnlyQuery: jest.fn().mockResolvedValue([
        { __scopeAccess: true, id: 'm1', content: 'alpha latest', createdAt: new Date().toISOString() },
        { __scopeAccess: true, id: 'm3', content: 'alpha newest', createdAt: new Date().toISOString() },
      ]),
    }));

    const { searchWithOpenSearchBackend } = require('../src/search/opensearchExecution');
    const out = await searchWithOpenSearchBackend('alpha', {
      communityId: 'community-1',
      userId: 'user-1',
      limit: 20,
      offset: 0,
    });

    expect(Array.isArray(out.hits)).toBe(true);
    expect(out.hits.map((h: any) => h.id)).toEqual(['m1', 'm3']);
    expect(out.hits.every((h: any) => String(h.content).includes('alpha'))).toBe(true);
  });

  it('returns 403 when Postgres recheck denies access', async () => {
    jest.resetModules();
    jest.doMock('../src/search/opensearchClient', () => ({
      OPENSEARCH_INDEX_MESSAGES: 'messages_v1',
      opensearchFetch: jest.fn().mockResolvedValue({
        hits: { hits: [{ _id: 'm1' }], total: { value: 1 } },
      }),
    }));
    jest.doMock('../src/search/searchExecution', () => ({
      runSearchQuery: jest.fn(),
      runSearchReadOnlyQuery: jest.fn().mockResolvedValue([{ __scopeAccess: false }]),
    }));

    const { searchWithOpenSearchBackend } = require('../src/search/opensearchExecution');
    await expect(
      searchWithOpenSearchBackend('private words', {
        communityId: 'community-private',
        userId: 'user-outsider',
        limit: 20,
        offset: 0,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Search client OpenSearch routing', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.SEARCH_BACKEND;
    delete process.env.OPENSEARCH_READ_ENABLED;
  });

  it('uses OpenSearch backend when SEARCH_BACKEND=opensearch and OPENSEARCH_READ_ENABLED=true', async () => {
    process.env.SEARCH_BACKEND = 'opensearch';
    process.env.OPENSEARCH_READ_ENABLED = 'true';
    const openSearchSearch = jest.fn().mockResolvedValue({ hits: [], offset: 0, limit: 20, estimatedTotalHits: 0 });
    jest.doMock('../src/search/opensearchExecution', () => ({
      searchWithOpenSearchBackend: openSearchSearch,
    }));
    jest.doMock('../src/search/meiliClient', () => ({
      isSearchBackend: jest.fn(() => false),
    }));

    const { search } = require('../src/search/client');
    await search('hello', { communityId: 'c1', userId: 'u1', limit: 20, offset: 0 });
    expect(openSearchSearch).toHaveBeenCalledTimes(1);
  });

  it('does not use OpenSearch backend when OPENSEARCH_READ_ENABLED=false', async () => {
    process.env.SEARCH_BACKEND = 'opensearch';
    process.env.OPENSEARCH_READ_ENABLED = 'false';
    const openSearchSearch = jest.fn();
    const meiliSearch = jest.fn().mockResolvedValue({ hits: [], offset: 0, limit: 20, estimatedTotalHits: 0 });
    jest.doMock('../src/search/opensearchExecution', () => ({
      searchWithOpenSearchBackend: openSearchSearch,
    }));
    jest.doMock('../src/search/meiliClient', () => ({
      isSearchBackend: jest.fn(() => true),
    }));
    jest.doMock('../src/search/meiliExecution', () => ({
      createMeiliSearchExecutor: jest.fn(() => ({
        searchWithMeiliBackend: meiliSearch,
      })),
    }));

    const { search } = require('../src/search/client');
    await search('hello', { communityId: 'c1', userId: 'u1', limit: 20, offset: 0 });
    expect(openSearchSearch).not.toHaveBeenCalled();
    expect(meiliSearch).toHaveBeenCalledTimes(1);
  });

  it('does not fallback when OpenSearch returns candidates', async () => {
    process.env.SEARCH_BACKEND = 'opensearch';
    process.env.OPENSEARCH_READ_ENABLED = 'true';

    const fallbackMetricInc = jest.fn();
    const openSearchSearch = jest.fn().mockResolvedValue({
      hits: [{ id: 'm1', createdAt: new Date().toISOString() }],
      offset: 0,
      limit: 20,
      estimatedTotalHits: 1,
      __opensearchCandidateCount: 1,
    });
    const runSearchTransaction = jest.fn();
    const runSearchQuery = jest.fn();

    jest.doMock('../src/search/opensearchExecution', () => ({
      searchWithOpenSearchBackend: openSearchSearch,
    }));
    jest.doMock('../src/search/meiliClient', () => ({
      isSearchBackend: jest.fn(() => false),
    }));
    jest.doMock('../src/search/searchExecution', () => ({
      runSearchQuery,
      runSearchReadOnlyQuery: jest.fn(),
      runSearchTransaction,
    }));
    jest.doMock('../src/utils/metrics/searchPerformance', () => ({
      searchReplicaRetryTotal: { inc: jest.fn() },
      searchFreshnessQueryDurationMs: { observe: jest.fn() },
      searchFreshnessCacheHitsTotal: { inc: jest.fn() },
      searchFreshnessCacheMissesTotal: { inc: jest.fn() },
      searchFreshnessSkippedShortQueryTotal: { inc: jest.fn() },
      searchOpenSearchFallbackTotal: { inc: fallbackMetricInc },
    }));

    const { search } = require('../src/search/client');
    const out = await search('hello', { communityId: 'c1', userId: 'u1', limit: 20, offset: 0 });
    expect(openSearchSearch).toHaveBeenCalledTimes(1);
    expect(runSearchTransaction).not.toHaveBeenCalled();
    expect(runSearchQuery).not.toHaveBeenCalled();
    expect(fallbackMetricInc).not.toHaveBeenCalled();
    expect(Array.isArray(out.hits)).toBe(true);
  });

  it('falls back to bounded Postgres search when OpenSearch returns zero candidates and increments metric', async () => {
    process.env.SEARCH_BACKEND = 'opensearch';
    process.env.OPENSEARCH_READ_ENABLED = 'true';

    const fallbackMetricInc = jest.fn();
    const openSearchSearch = jest.fn().mockResolvedValue({
      hits: [],
      offset: 0,
      limit: 20,
      estimatedTotalHits: 0,
      __opensearchCandidateCount: 0,
    });
    const txQuery = jest.fn().mockResolvedValue({ rows: [] });
    const runSearchTransaction = jest.fn(async (fn: any) => fn({ query: txQuery }));
    const runSearchQuery = jest.fn();

    jest.doMock('../src/search/opensearchExecution', () => ({
      searchWithOpenSearchBackend: openSearchSearch,
    }));
    jest.doMock('../src/search/meiliClient', () => ({
      isSearchBackend: jest.fn(() => false),
    }));
    jest.doMock('../src/search/searchExecution', () => ({
      runSearchQuery,
      runSearchReadOnlyQuery: jest.fn(),
      runSearchTransaction,
    }));
    jest.doMock('../src/utils/metrics/searchPerformance', () => ({
      searchReplicaRetryTotal: { inc: jest.fn() },
      searchFreshnessQueryDurationMs: { observe: jest.fn() },
      searchFreshnessCacheHitsTotal: { inc: jest.fn() },
      searchFreshnessCacheMissesTotal: { inc: jest.fn() },
      searchFreshnessSkippedShortQueryTotal: { inc: jest.fn() },
      searchOpenSearchFallbackTotal: { inc: fallbackMetricInc },
    }));

    const { search } = require('../src/search/client');
    const out = await search('hello', { communityId: 'c1', userId: 'u1', limit: 20, offset: 0 });
    expect(openSearchSearch).toHaveBeenCalledTimes(1);
    expect(runSearchTransaction).toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalled();
    expect(fallbackMetricInc).toHaveBeenCalledWith({ reason: 'empty_candidates', scope: 'community' });
    expect(out).toEqual(
      expect.objectContaining({
        hits: expect.any(Array),
        offset: 0,
        limit: 20,
      }),
    );
  });
});
