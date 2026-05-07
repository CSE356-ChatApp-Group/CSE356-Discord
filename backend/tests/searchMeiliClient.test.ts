describe('meiliClient search request semantics', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...OLD_ENV,
      MEILI_ENABLED: 'true',
      SEARCH_BACKEND: 'meili',
      MEILI_HOST: 'http://meili.test',
      MEILI_MASTER_KEY: 'test-key',
      MEILI_INDEX_MESSAGES: 'messages',
    };
    require('prom-client').register.clear();
    jest.doMock('../src/db/redis', () => ({
      redisSearch: {
        xadd: jest.fn(),
        duplicate: jest.fn(),
      },
    }));
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
    jest.dontMock('http');
    jest.dontMock('https');
    delete (global as any).fetch;
  });

  it('requires all query terms when asking Meili for candidates', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        hits: [{ id: '00000000-0000-4000-8000-000000000001' }],
        estimatedTotalHits: 1,
      }),
    });

    const { searchMessageCandidates } = require('../src/search/meiliClient');
    await searchMessageCandidates('alpha beta gamma', {
      communityId: '00000000-0000-4000-8000-000000000010',
      limit: 5,
    });

    const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      q: 'alpha beta gamma',
      matchingStrategy: 'all',
    });
  });

  it('strips English stop words from the Meili query to align with websearch_to_tsquery', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ hits: [], estimatedTotalHits: 0 }),
    });

    const { searchMessageCandidates } = require('../src/search/meiliClient');

    const cases: [string, string][] = [
      ['hate that word',       'hate word'],       // "that" is stop word
      ['been holding this',    'holding'],          // "been" + "this" are stop words
      ['more utility spells',  'utility spells'],   // "more" is stop word
      ['mention their name',   'mention name'],     // "their" is stop word
      ['always just imagined', 'always imagined'],  // "just" is stop word
      ['into kuchisake onna',  'kuchisake onna'],   // "into" is stop word
      ['keep learning more',   'keep learning'],    // "more" is stop word
      ['alpha beta gamma',     'alpha beta gamma'], // no stop words — unchanged
    ];

    for (const [input, expected] of cases) {
      (global as any).fetch.mockClear();
      await searchMessageCandidates(input, {
        communityId: '00000000-0000-4000-8000-000000000010',
      });
      const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
      expect(body.q).toBe(expected);
    }
  });

  it('falls back to original query when all tokens are stop words', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ hits: [], estimatedTotalHits: 0 }),
    });

    const { searchMessageCandidates } = require('../src/search/meiliClient');
    await searchMessageCandidates('is the a', {
      communityId: '00000000-0000-4000-8000-000000000010',
    });

    const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
    expect(body.q).toBe('is the a');
  });

  it('configures the index without typo-tolerant content candidates', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => '',
    });

    const { setupIndex } = require('../src/search/meiliClient');
    await setupIndex();

    const typoCall = (global as any).fetch.mock.calls.find(([url]: [string]) => (
      url.endsWith('/indexes/messages/settings/typo-tolerance')
    ));
    expect(typoCall).toBeDefined();
    expect(JSON.parse(typoCall[1].body)).toEqual({ enabled: false });
  });

  it('configures English stop words in the index to align with websearch_to_tsquery', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => '',
    });

    const { setupIndex } = require('../src/search/meiliClient');
    await setupIndex();

    const stopWordsCall = (global as any).fetch.mock.calls.find(([url]: [string]) => (
      url.endsWith('/indexes/messages/settings/stop-words')
    ));
    expect(stopWordsCall).toBeDefined();
    const body = JSON.parse(stopWordsCall[1].body);
    expect(Array.isArray(body)).toBe(true);
    // Verify a representative sample of stop words are included
    expect(body).toContain('the');
    expect(body).toContain('that');
    expect(body).toContain('this');
    expect(body).toContain('been');
    expect(body).toContain('more');
    expect(body).toContain('just');
    expect(body).toContain('into');
  });

  it('uses a keep-alive HTTP agent outside test mode', async () => {
    const { EventEmitter } = require('events');
    const requestMock = jest.fn((options, callback) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'application/json' };
      process.nextTick(() => {
        callback(res);
        res.emit('data', JSON.stringify({ hits: [], estimatedTotalHits: 0 }));
        res.emit('end');
      });
      return {
        setTimeout: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };
    });
    const Agent = jest.fn(function MockAgent(this: any, options: any) {
      this.options = options;
    });

    jest.doMock('http', () => ({ Agent, request: requestMock }));
    jest.doMock('https', () => ({ Agent, request: jest.fn() }));
    process.env.NODE_ENV = 'production';
    delete (global as any).fetch;

    const { searchMessageCandidates } = require('../src/search/meiliClient');
    await searchMessageCandidates('alpha beta', {
      communityId: '00000000-0000-4000-8000-000000000010',
    });

    expect(Agent).toHaveBeenCalledWith(expect.objectContaining({ keepAlive: true }));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          options: expect.objectContaining({ keepAlive: true }),
        }),
        method: 'POST',
        path: '/indexes/messages/search',
      }),
      expect.any(Function),
    );
  });
});
