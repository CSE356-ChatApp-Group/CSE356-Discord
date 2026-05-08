/**
 * Bounded empty-Meili recent rescue (indexing lag) — unit tests with mocked DB.
 */
const { createMeiliSearchExecutor } = require('../src/search/meiliExecution');
const {
  SELECT_COLS,
  FROM_CLAUSE,
  buildScopedAccessParts,
  p,
  buildFilters,
} = require('../src/search/sqlParts');
const {
  tokenizeStrictSearchTerms,
  messageMatchesAllStrictTerms,
  buildResult,
} = require('../src/search/resultFormatting');

describe('empty Meili recent rescue', () => {
  const OLD = process.env;

  function makeExecutor({
    candidateIds,
    recheckRows,
    rescueRows,
    searchOnceResult = { hits: [], offset: 0, limit: 20, estimatedTotalHits: 0, processingTimeMs: 0, query: '' },
  }: {
    candidateIds: string[];
    recheckRows: any[];
    rescueRows?: any[];
    searchOnceResult?: any;
  }) {
    const meiliClient = {
      searchMessageCandidates: jest.fn().mockResolvedValue({
        ids: candidateIds,
        estimatedTotal: candidateIds.length,
      }),
      incFallbackTotal: jest.fn(),
    };
    const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    const runSearchReadOnlyQuery = jest.fn().mockImplementation(
      async (_sql: string, _params: any[], opts?: { kind?: string }) => {
        if (opts?.kind === 'empty_meili_recent_rescue') {
          return rescueRows ?? [];
        }
        return recheckRows;
      },
    );
    const searchOnce = jest.fn().mockResolvedValue(searchOnceResult);
    const searchStrictLiteralFallback = jest.fn().mockResolvedValue(searchOnceResult);

    const executor = createMeiliSearchExecutor({
      meiliClient,
      logger,
      runSearchQuery: runSearchReadOnlyQuery,
      runSearchReadOnlyQuery,
      findFreshScopedSearchCandidateIds: jest.fn().mockResolvedValue([]),
      resolvedSearchScope: (opts: Record<string, any>) => (opts.communityId ? 'community' : 'conversation'),
      buildScopedAccessParts,
      p,
      buildFilters,
      SELECT_COLS,
      FROM_CLAUSE,
      tokenizeStrictSearchTerms,
      messageMatchesAllStrictTerms,
      buildResult,
      createMeiliFallbackError: (code: string) => {
        const err: any = new Error(code);
        err.meiliUnavailable = true;
        err.code = code;
        return err;
      },
      searchUseReadReplica: false,
      searchOnce,
      searchStrictLiteralFallback,
    });

    return { executor, meiliClient, runSearchReadOnlyQuery, searchOnce, searchStrictLiteralFallback };
  }

  beforeEach(() => {
    process.env = { ...OLD };
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_ENABLED = 'true';
    process.env.MEILI_EMPTY_CANDIDATES_FALLBACK_ENABLED = 'false';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_TIMEOUT_MS = '150';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_WINDOW_MS = '120000';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_LIMIT = '250';
  });

  afterEach(() => {
    process.env = OLD;
  });

  const communityOpts = {
    communityId: '00000000-0000-4000-8000-000000000005',
    userId: '00000000-0000-4000-8000-000000000003',
    limit: 20,
    offset: 0,
  };

  const hitRow = {
    __scopeAccess: true,
    __emptyMeiliRescueScanCount: 1,
    id: '00000000-0000-4000-8000-000000000099',
    content: 'unique rescue token alpha beta',
    authorId: '00000000-0000-4000-8000-000000000003',
    authorDisplayName: 'A',
    channelId: '00000000-0000-4000-8000-000000000004',
    conversationId: null,
    communityId: '00000000-0000-4000-8000-000000000005',
    channelName: 'general',
    createdAt: '2026-05-07T12:40:29.000Z',
  };

  it('rescues a recent message when Meili returns no candidates', async () => {
    const { executor, runSearchReadOnlyQuery, searchOnce } = makeExecutor({
      candidateIds: [],
      recheckRows: [],
      rescueRows: [hitRow],
    });

    const out = await executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts);

    expect(out.hits.length).toBe(1);
    expect(out.hits[0].id).toBe(hitRow.id);
    expect(
      runSearchReadOnlyQuery.mock.calls.some(
        (c: any[]) => c[2]?.kind === 'empty_meili_recent_rescue',
      ),
    ).toBe(true);
    expect(searchOnce).not.toHaveBeenCalled();
  });

  it('does not run rescue when Meili returns candidates', async () => {
    const { executor, runSearchReadOnlyQuery } = makeExecutor({
      candidateIds: ['00000000-0000-4000-8000-000000000001'],
      recheckRows: [
        {
          __scopeAccess: true,
          id: '00000000-0000-4000-8000-000000000001',
          content: 'unique rescue token alpha beta',
          authorId: '00000000-0000-4000-8000-000000000003',
          authorDisplayName: 'A',
          channelId: '00000000-0000-4000-8000-000000000004',
          conversationId: null,
          communityId: '00000000-0000-4000-8000-000000000005',
          channelName: 'general',
          createdAt: '2026-05-07T12:40:29.000Z',
        },
      ],
    });

    await executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts);

    expect(
      runSearchReadOnlyQuery.mock.calls.some(
        (c: any[]) => c[2]?.kind === 'empty_meili_recent_rescue',
      ),
    ).toBe(false);
  });

  it('does not rescue when strict filter removes content', async () => {
    const { executor, runSearchReadOnlyQuery } = makeExecutor({
      candidateIds: [],
      recheckRows: [],
      rescueRows: [
        {
          ...hitRow,
          content: 'no match here',
        },
      ],
    });

    const out = await executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts);

    expect(out.hits.length).toBe(0);
    expect(
      runSearchReadOnlyQuery.mock.calls.some(
        (c: any[]) => c[2]?.kind === 'empty_meili_recent_rescue',
      ),
    ).toBe(true);
  });

  it('returns 403 when scope denies access', async () => {
    const { executor } = makeExecutor({
      candidateIds: [],
      recheckRows: [],
      rescueRows: [{ ...hitRow, __scopeAccess: false }],
    });

    await expect(
      executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('passes authorId into rescue query params via scoped SQL', async () => {
    const { executor, runSearchReadOnlyQuery } = makeExecutor({
      candidateIds: [],
      recheckRows: [],
      rescueRows: [],
    });

    await executor.searchWithMeiliBackend('unique rescue token alpha beta', {
      ...communityOpts,
      authorId: '00000000-0000-4000-8000-0000000000aa',
    });

    const rescueCall = runSearchReadOnlyQuery.mock.calls.find(
      (c: any[]) => c[2]?.kind === 'empty_meili_recent_rescue',
    );
    expect(rescueCall).toBeDefined();
    expect(rescueCall![1]).toContainEqual('00000000-0000-4000-8000-0000000000aa');
  });

  it('returns empty on timeout without calling searchOnce', async () => {
    const meiliClient = {
      searchMessageCandidates: jest.fn().mockResolvedValue({ ids: [], estimatedTotal: 0 }),
      incFallbackTotal: jest.fn(),
    };
    const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    const runSearchReadOnlyQuery = jest.fn().mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const searchOnce = jest.fn();
    const executor = createMeiliSearchExecutor({
      meiliClient,
      logger,
      runSearchQuery: runSearchReadOnlyQuery,
      runSearchReadOnlyQuery,
      findFreshScopedSearchCandidateIds: jest.fn().mockResolvedValue([]),
      resolvedSearchScope: () => 'community',
      buildScopedAccessParts,
      p,
      buildFilters,
      SELECT_COLS,
      FROM_CLAUSE,
      tokenizeStrictSearchTerms,
      messageMatchesAllStrictTerms,
      buildResult,
      createMeiliFallbackError: (code: string) => {
        const err: any = new Error(code);
        err.meiliUnavailable = true;
        return err;
      },
      searchUseReadReplica: false,
      searchOnce,
      searchStrictLiteralFallback: jest.fn(),
    });

    const out = await executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts);

    expect(out.hits.length).toBe(0);
    expect(searchOnce).not.toHaveBeenCalled();
  });

  it('skips rescue when disabled', async () => {
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_ENABLED = 'false';
    const { executor, runSearchReadOnlyQuery } = makeExecutor({
      candidateIds: [],
      recheckRows: [],
      rescueRows: [hitRow],
    });

    const out = await executor.searchWithMeiliBackend('unique rescue token alpha beta', communityOpts);

    expect(out.hits.length).toBe(0);
    expect(
      runSearchReadOnlyQuery.mock.calls.some(
        (c: any[]) => c[2]?.kind === 'empty_meili_recent_rescue',
      ),
    ).toBe(false);
  });
});
