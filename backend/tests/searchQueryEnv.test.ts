describe('search query env clamps', () => {
  const originalStrictCap = process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT;

  afterEach(() => {
    jest.resetModules();
    if (originalStrictCap === undefined) {
      delete process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT;
    } else {
      process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT = originalStrictCap;
    }
    delete process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_WINDOW_MS;
    delete process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_LIMIT;
    delete process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_TIMEOUT_MS;
  });

  it('keeps Meili strict-mismatch literal rescue shallower than full fallback', () => {
    delete process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT;
    jest.resetModules();

    const {
      literalRecentCandidateCapDeep,
      literalStrictMismatchCandidateCap,
    } = require('../src/search/searchQueryEnv');

    expect(literalRecentCandidateCapDeep()).toBe(3000);
    expect(literalStrictMismatchCandidateCap()).toBe(1000);
  });

  it('clamps the strict-mismatch literal rescue cap', () => {
    process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT = '99999';
    jest.resetModules();
    let env = require('../src/search/searchQueryEnv');
    expect(env.literalStrictMismatchCandidateCap()).toBe(1500);

    process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT = '1';
    jest.resetModules();
    env = require('../src/search/searchQueryEnv');
    expect(env.literalStrictMismatchCandidateCap()).toBe(500);
  });

  it('clamps empty-Meili recent rescue tunables', () => {
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_WINDOW_MS = '999999999';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_LIMIT = '9999';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_TIMEOUT_MS = '9999';
    jest.resetModules();
    const env = require('../src/search/searchQueryEnv');
    expect(env.emptyMeiliRecentRescueWindowMs()).toBe(300_000);
    expect(env.emptyMeiliRecentRescueLimit()).toBe(500);
    expect(env.emptyMeiliRecentRescueTimeoutMs()).toBe(500);

    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_WINDOW_MS = '1';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_LIMIT = '1';
    process.env.SEARCH_EMPTY_MEILI_RECENT_RESCUE_TIMEOUT_MS = '1';
    jest.resetModules();
    const env2 = require('../src/search/searchQueryEnv');
    expect(env2.emptyMeiliRecentRescueWindowMs()).toBe(10_000);
    expect(env2.emptyMeiliRecentRescueLimit()).toBe(50);
    expect(env2.emptyMeiliRecentRescueTimeoutMs()).toBe(50);
  });

  it('clamps OpenSearch max candidates', () => {
    process.env.OPENSEARCH_MAX_CANDIDATES = '999999';
    jest.resetModules();
    let env = require('../src/search/searchQueryEnv');
    expect(env.openSearchMaxCandidates()).toBe(2000);

    process.env.OPENSEARCH_MAX_CANDIDATES = '1';
    jest.resetModules();
    env = require('../src/search/searchQueryEnv');
    expect(env.openSearchMaxCandidates()).toBe(50);
  });
});
