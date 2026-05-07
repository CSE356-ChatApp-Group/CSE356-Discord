describe('search query env clamps', () => {
  const originalStrictCap = process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT;

  afterEach(() => {
    jest.resetModules();
    if (originalStrictCap === undefined) {
      delete process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT;
    } else {
      process.env.SEARCH_STRICT_LITERAL_RECENT_CANDIDATES_LIMIT = originalStrictCap;
    }
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
});
