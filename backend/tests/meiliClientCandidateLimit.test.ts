describe('Meili client candidate limit', () => {
  const originalEnv = {
    MEILI_HOST: process.env.MEILI_HOST,
    MEILI_MASTER_KEY: process.env.MEILI_MASTER_KEY,
    MEILI_CANDIDATE_LIMIT: process.env.MEILI_CANDIDATE_LIMIT,
    MEILI_CANDIDATE_MIN_LIMIT: process.env.MEILI_CANDIDATE_MIN_LIMIT,
  };
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses the configured candidate limit as a ceiling instead of a default-page floor', async () => {
    process.env.MEILI_HOST = 'http://meili.test';
    process.env.MEILI_MASTER_KEY = 'test-key';
    process.env.MEILI_CANDIDATE_LIMIT = '1000';
    delete process.env.MEILI_CANDIDATE_MIN_LIMIT;
    jest.resetModules();

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ hits: [], estimatedTotalHits: 0 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { searchMessageCandidates } = require('../src/search/meiliClient');

    await searchMessageCandidates('broad query', {
      communityId: '00000000-0000-4000-8000-000000000001',
      limit: 20,
      offset: 0,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.limit).toBe(100);
  });

  it('still expands for larger pages and caps at MEILI_CANDIDATE_LIMIT', async () => {
    process.env.MEILI_HOST = 'http://meili.test';
    process.env.MEILI_MASTER_KEY = 'test-key';
    process.env.MEILI_CANDIDATE_LIMIT = '300';
    jest.resetModules();

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ hits: [], estimatedTotalHits: 0 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { searchMessageCandidates } = require('../src/search/meiliClient');

    await searchMessageCandidates('large page', {
      communityId: '00000000-0000-4000-8000-000000000001',
      limit: 100,
      offset: 50,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.limit).toBe(300);
  });
});
