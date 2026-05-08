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
