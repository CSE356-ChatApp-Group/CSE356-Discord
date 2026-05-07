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

describe('Meili execution strict all-term recheck', () => {
  function makeExecutor({
    candidateIds,
    recheckRows,
    searchOnceResult = { hits: [], offset: 0, limit: 20, estimatedTotalHits: 0, processingTimeMs: 0, query: '' },
  }: {
    candidateIds: string[];
    recheckRows: any[];
    searchOnceResult?: any;
  }) {
    const meiliClient = {
      searchMessageCandidates: jest.fn().mockResolvedValue({
        ids: candidateIds,
        estimatedTotal: candidateIds.length,
      }),
      incFallbackTotal: jest.fn(),
    };
    const logger = {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    };
    const runSearchReadOnlyQuery = jest.fn().mockResolvedValue(recheckRows);
    const searchOnce = jest.fn().mockResolvedValue(searchOnceResult);

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
    });

    return { executor, meiliClient, runSearchReadOnlyQuery, searchOnce };
  }

  it('falls back instead of returning a candidate missing a stop word from the original query', async () => {
    const candidateId = '00000000-0000-4000-8000-000000000001';
    const fallbackResult = {
      hits: [{ id: '00000000-0000-4000-8000-000000000002', content: 'disconnect with half' }],
      offset: 0,
      limit: 20,
      estimatedTotalHits: 1,
      processingTimeMs: 0,
      query: 'disconnect with half',
    };
    const { executor, meiliClient, searchOnce } = makeExecutor({
      candidateIds: [candidateId],
      recheckRows: [
        {
          __scopeAccess: true,
          id: candidateId,
          content: 'disconnect around half',
          authorId: '00000000-0000-4000-8000-000000000003',
          authorDisplayName: 'A',
          channelId: '00000000-0000-4000-8000-000000000004',
          conversationId: null,
          communityId: '00000000-0000-4000-8000-000000000005',
          channelName: 'general',
          createdAt: '2026-05-07T12:40:29.000Z',
        },
      ],
      searchOnceResult: fallbackResult,
    });

    const out = await executor.searchWithMeiliBackend('disconnect with half', {
      communityId: '00000000-0000-4000-8000-000000000005',
      userId: '00000000-0000-4000-8000-000000000003',
      limit: 20,
      offset: 0,
    });

    expect(out).toBe(fallbackResult);
    expect(meiliClient.incFallbackTotal).toHaveBeenCalledWith('strict_token_mismatch');
    expect(searchOnce).toHaveBeenCalledWith(
      'disconnect with half',
      expect.objectContaining({ communityId: '00000000-0000-4000-8000-000000000005' }),
      true,
    );
  });

  it('returns rechecked Meili rows when every original query term is present', async () => {
    const candidateId = '00000000-0000-4000-8000-000000000011';
    const { executor, meiliClient, searchOnce } = makeExecutor({
      candidateIds: [candidateId],
      recheckRows: [
        {
          __scopeAccess: true,
          id: candidateId,
          content: 'disconnect with half',
          authorId: '00000000-0000-4000-8000-000000000013',
          authorDisplayName: 'A',
          channelId: '00000000-0000-4000-8000-000000000014',
          conversationId: null,
          communityId: '00000000-0000-4000-8000-000000000015',
          channelName: 'general',
          createdAt: '2026-05-07T12:40:29.000Z',
        },
      ],
    });

    const out = await executor.searchWithMeiliBackend('disconnect with half', {
      communityId: '00000000-0000-4000-8000-000000000015',
      userId: '00000000-0000-4000-8000-000000000013',
      limit: 20,
      offset: 0,
    });

    expect(out.hits.map((h: any) => h.id)).toEqual([candidateId]);
    expect(meiliClient.incFallbackTotal).not.toHaveBeenCalledWith('strict_token_mismatch');
    expect(searchOnce).not.toHaveBeenCalled();
  });
});
