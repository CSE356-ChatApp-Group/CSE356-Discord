/**
 * Unit coverage for the Meili-first failure boundary.
 *
 * If Meili already returned candidates, a Postgres recheck timeout must not
 * cascade into a full Postgres FTS fallback. That fallback is intentionally kept
 * for Meili candidate-generation failures and empty-candidate behavior only.
 */

describe('Search - Meili candidate recheck errors', () => {
  const originalSearchUseReadReplica = process.env.SEARCH_USE_READ_REPLICA;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    if (originalSearchUseReadReplica == null) {
      delete process.env.SEARCH_USE_READ_REPLICA;
    } else {
      process.env.SEARCH_USE_READ_REPLICA = originalSearchUseReadReplica;
    }
  });

  it('returns busy without running full Postgres FTS fallback when candidate recheck times out', async () => {
    process.env.SEARCH_USE_READ_REPLICA = 'false';
    jest.resetModules();

    const candidateId = '00000000-0000-4000-8000-000000000001';
    const communityId = '00000000-0000-4000-8000-000000000002';
    const userId = '00000000-0000-4000-8000-000000000003';

    jest.doMock('../src/search/meiliClient', () => ({
      isEnabled: jest.fn(() => true),
      isSearchBackend: jest.fn(() => true),
      searchMessageCandidates: jest.fn().mockResolvedValue({
        ids: [candidateId],
        estimatedTotal: 1,
      }),
      incFallbackTotal: jest.fn(),
      indexMessage: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      batchIndexMessages: jest.fn().mockResolvedValue(undefined),
      checkHealth: jest.fn().mockResolvedValue({ ok: true, status: 'available' }),
      checkIndex: jest.fn().mockResolvedValue({ ok: true, uid: 'messages' }),
      setupIndex: jest.fn().mockResolvedValue(undefined),
      MEILI_INDEX_MESSAGES: 'messages',
    }));

    const logger = require('../src/utils/logger');
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const pool = require('../src/db/pool');
    const mockQuery = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Query read timeout'))
      .mockResolvedValueOnce({});
    jest.spyOn(pool, 'getClientTimed').mockResolvedValue({
      client: { query: mockQuery, release: jest.fn() },
      acquireMs: 0,
    });

    const { search } = require('../src/search/client');

    await expect(search('candidate timeout', {
      communityId,
      userId,
      limit: 10,
      offset: 0,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SEARCH_RECHECK_BUSY',
    });

    const meiliClient = require('../src/search/meiliClient');
    expect(meiliClient.incFallbackTotal).toHaveBeenCalledWith('recheck_error');
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});
