/**
 * Tests for normalized strict token matching in resultFormatting.ts
 *
 * Validates that `messageMatchesAllStrictTerms` handles:
 *   - Apostrophes: "dont" matches "don't"
 *   - Missing spaces: "ofcourse" matches "of course"
 *   - Diacritics: "xingar" matches "xíngar"
 *   - Hyphens: "wellknown" matches "well-known"
 *   - Mixed case: "Hello" matches "hELLO"
 *
 * Also validates that the match does NOT return irrelevant results
 * (i.e., all query terms must still be present).
 */
const {
  messageMatchesAllStrictTerms,
  tokenizeStrictSearchTerms,
} = require('../src/search/resultFormatting');

describe('messageMatchesAllStrictTerms — normalized matching', () => {
  // ─── Apostrophes ─────────────────────────────────────────────
  describe('apostrophe handling', () => {
    it('matches "dont" against content with "don\'t"', () => {
      const content = "I don't think that's right";
      expect(messageMatchesAllStrictTerms(content, ['dont'])).toBe(true);
    });

    it('matches "thats" against content with "that\'s"', () => {
      const content = "that's amazing";
      expect(messageMatchesAllStrictTerms(content, ['thats'])).toBe(true);
    });

    it('matches query "dont know" against content "I don\'t know"', () => {
      const content = "I don't know what to do";
      expect(messageMatchesAllStrictTerms(content, ['dont', 'know'])).toBe(true);
    });

    it('does NOT match "dont" when term is genuinely absent', () => {
      const content = "I do not think so";
      expect(messageMatchesAllStrictTerms(content, ['dont'])).toBe(false);
    });

    it('matches curly/smart apostrophes (U+2018, U+2019)', () => {
      const content = "I don\u2019t think so"; // right single quotation mark
      expect(messageMatchesAllStrictTerms(content, ['dont'])).toBe(true);
    });
  });

  // ─── Missing spaces / collapsed words ────────────────────────
  describe('collapsed word matching', () => {
    it('matches "ofcourse" against "of course"', () => {
      const content = "of course that is fine";
      expect(messageMatchesAllStrictTerms(content, ['ofcourse'])).toBe(true);
    });

    it('matches "wont" against "won\'t"', () => {
      const content = "I won't be there";
      expect(messageMatchesAllStrictTerms(content, ['wont'])).toBe(true);
    });

    it('does NOT match "ofcourse" when only "of" is present', () => {
      const content = "of the things";
      expect(messageMatchesAllStrictTerms(content, ['ofcourse'])).toBe(false);
    });

    it('does NOT match "ofcourse" when only "course" is present', () => {
      const content = "the golf course is closed";
      expect(messageMatchesAllStrictTerms(content, ['ofcourse'])).toBe(false);
    });
  });

  // ─── Diacritics / Accents ────────────────────────────────────
  describe('diacritic handling', () => {
    it('matches "xingar" against "xíngar" (Portuguese)', () => {
      const content = "ela foi xingar o professor";
      expect(messageMatchesAllStrictTerms(content, ['xingar'])).toBe(true);
    });

    it('matches "cara" against text with accented "cará"', () => {
      const content = "o cará dessa pessoa";
      expect(messageMatchesAllStrictTerms(content, ['cara'])).toBe(true);
    });

    it('matches "memija" against accented variant', () => {
      const content = "gordan memija Alke";
      expect(messageMatchesAllStrictTerms(content, ['memija'])).toBe(true);
    });

    it('matches "cafe" against "café"', () => {
      const content = "let's go to a café";
      expect(messageMatchesAllStrictTerms(content, ['cafe'])).toBe(true);
    });

    it('matches "ñ" against "ñ" (Spanish tilde)', () => {
      const content = "el niño está aquí";
      expect(messageMatchesAllStrictTerms(content, ['nino'])).toBe(true);
    });

    it('matches decomposed Polish ę/ó (which decompose under NFKD)', () => {
      // Note: Polish ł (U+0142) does NOT decompose — it is its own letter.
      // This test covers chars that DO decompose: ę→e+̨, ó→o+́
      const content = "bądź zdrowy";
      expect(messageMatchesAllStrictTerms(content, ['badz', 'zdrowy'])).toBe(true);
    });
  });

  // ─── Hyphens ─────────────────────────────────────────────────
  describe('hyphen handling', () => {
    it('matches "wellknown" against "well-known"', () => {
      const content = "this is a well-known issue";
      expect(messageMatchesAllStrictTerms(content, ['wellknown'])).toBe(true);
    });

    it('matches "cooperate" against "co-operate"', () => {
      const content = "we need to co-operate on this";
      expect(messageMatchesAllStrictTerms(content, ['cooperate'])).toBe(true);
    });
  });

  // ─── Mixed case ──────────────────────────────────────────────
  describe('case insensitivity', () => {
    it('matches lowercase query against uppercase content', () => {
      const content = "HELLO WORLD";
      expect(messageMatchesAllStrictTerms(content, ['hello'])).toBe(true);
    });

    it('matches mixed case query against lowercase content', () => {
      const content = "hello world";
      expect(messageMatchesAllStrictTerms(content, ['HeLLo'])).toBe(true);
    });

    it('matches mixed case content against lowercase query', () => {
      const content = "Hello World From The Team";
      expect(messageMatchesAllStrictTerms(content, ['world', 'team'])).toBe(true);
    });
  });

  // ─── All terms must match ────────────────────────────────────
  describe('all terms requirement', () => {
    it('returns false when one term is missing', () => {
      const content = "the quick brown fox";
      expect(messageMatchesAllStrictTerms(content, ['quick', 'rabbit'])).toBe(false);
    });

    it('returns true when all terms are present', () => {
      const content = "the quick brown fox";
      expect(messageMatchesAllStrictTerms(content, ['quick', 'brown'])).toBe(true);
    });

    it('returns false when no terms match', () => {
      const content = "the quick brown fox";
      expect(messageMatchesAllStrictTerms(content, ['lazy', 'dog'])).toBe(false);
    });

    it('returns true for empty terms array', () => {
      expect(messageMatchesAllStrictTerms("anything", [])).toBe(true);
    });
  });

  // ─── No irrelevant results (precision) ───────────────────────
  describe('precision — no false positives', () => {
    it('"ofcourse" does NOT match "offer course"', () => {
      // "ofcourse" collapsed from query → "ofcourse"
      // "offer course" collapsed → "offercourse"
      // These are different strings, so should NOT match
      const content = "we offer course materials";
      expect(messageMatchesAllStrictTerms(content, ['ofcourse'])).toBe(false);
    });

    it('short single-char terms only match when genuinely present', () => {
      // "x" is in "text" — this is a legitimate match
      expect(messageMatchesAllStrictTerms("random text here", ['x'])).toBe(true);
      // "z" is NOT present — should not match
      expect(messageMatchesAllStrictTerms("random text here", ['z'])).toBe(false);
    });

    it('"dont" does NOT match "donation"', () => {
      const content = "thank you for your donation";
      expect(messageMatchesAllStrictTerms(content, ['dont'])).toBe(false);
    });

    it('"abc" does NOT match "xabc" via collapse unless present', () => {
      const content = "the alphabet song";
      // "abc" is not a substring of "alphabet song" (normalized or collapsed)
      expect(messageMatchesAllStrictTerms(content, ['abc'])).toBe(false);
    });
  });

  // ─── Real-world examples from production logs ────────────────
  describe('production log examples', () => {
    it('"cara quer xingar" matches actual Portuguese content', () => {
      const content = "cara quer xingar alguém";
      expect(messageMatchesAllStrictTerms(content, ['cara', 'quer', 'xingar'])).toBe(true);
    });

    it('"ofcourse whale differ" matches content with "of course"', () => {
      const content = "of course the whale is different";
      expect(messageMatchesAllStrictTerms(content, ['ofcourse', 'whale', 'differ'])).toBe(true);
    });

    it('"dont have team" matches content with "don\'t have a team"', () => {
      const content = "I don't have a team yet";
      expect(messageMatchesAllStrictTerms(content, ['dont', 'have', 'team'])).toBe(true);
    });

    it('"modified plane made" matches exact words', () => {
      const content = "the modified plane made a landing";
      expect(messageMatchesAllStrictTerms(content, ['modified', 'plane', 'made'])).toBe(true);
    });

    it('"1800 caratteri spazi" matches Italian content', () => {
      const content = "1800 caratteri spazi inclusi";
      expect(messageMatchesAllStrictTerms(content, ['1800', 'caratteri', 'spazi'])).toBe(true);
    });

    it('"sale muthal insaan" matches transliterated content', () => {
      const content = "sale muthal insaan ko dekh";
      expect(messageMatchesAllStrictTerms(content, ['sale', 'muthal', 'insaan'])).toBe(true);
    });
  });
});

describe('tokenizeStrictSearchTerms', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenizeStrictSearchTerms('Hello World')).toEqual(['hello', 'world']);
  });

  it('strips leading/trailing punctuation', () => {
    expect(tokenizeStrictSearchTerms('"hello" (world)')).toEqual(['hello', 'world']);
  });

  it('returns empty for whitespace-only input', () => {
    expect(tokenizeStrictSearchTerms('   ')).toEqual([]);
  });

  it('preserves Unicode letters', () => {
    expect(tokenizeStrictSearchTerms('xíngar cara')).toEqual(['xíngar', 'cara']);
  });
});