// English stop words that Postgres websearch_to_tsquery('english', ...)
// drops before building its tsquery. Meili uses the same set in index settings
// and query normalization so candidate search and strict recheck agree.
const ENGLISH_STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as',
  'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in',
  'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'now', 'can', 'will', 'should',
  's', 't', 'd', 'll', 'm', 'o', 're', 've', 'y',
]);

function stripEnglishStopWords(q: string): string {
  const trimmed = String(q || '').trim();
  const kept = trimmed.split(/\s+/).filter(
    (tok) => tok.length > 0 && !ENGLISH_STOP_WORDS.has(tok.toLowerCase()),
  );
  return kept.length > 0 ? kept.join(' ') : trimmed;
}

module.exports = {
  ENGLISH_STOP_WORDS,
  stripEnglishStopWords,
};
