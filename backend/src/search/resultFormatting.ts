const STRICT_TERM_MIN_LEN = 1;

/**
 * Normalize text for strict substring matching:
 *   - lowercase
 *   - strip diacritics (é→e, ñ→n, ç→c)
 *   - remove apostrophes and hyphens (don't→dont, well-known→wellknown)
 *   - collapse whitespace
 *
 * This bridges the gap between user queries (no accents/punctuation) and
 * message content that may contain them. Used only for the Meili candidate
 * strict-filter pass — NOT for tokenization or display.
 */
function normalizeForStrictMatch(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')       // strip combining diacritical marks
    .replace(/[''\u2018\u2019`\u00B4-]/g, '') // remove apostrophes/hyphens
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fully collapsed version: remove ALL non-alphanumeric characters.
 * Used as a fallback check so "ofcourse" matches "of course".
 * Only applied when the normalized (spaces-preserved) check fails.
 */
function collapseForStrictMatch(s: string): string {
  return normalizeForStrictMatch(s).replace(/[^a-z0-9]/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHeadline(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/%%EM_START%%/g, '<em>')
    .replace(/%%EM_END%%/g, '</em>');
}

function buildHighlightRanges(content: string, terms: string[]) {
  const normalizedTerms = Array.from(
    new Set(
      (terms || [])
        .map((term) => String(term || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length);

  if (!normalizedTerms.length || !content) return [];

  const lowerContent = content.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of normalizedTerms) {
    let fromIndex = 0;
    while (fromIndex < lowerContent.length) {
      const foundAt = lowerContent.indexOf(term, fromIndex);
      if (foundAt < 0) break;
      ranges.push({ start: foundAt, end: foundAt + term.length });
      fromIndex = foundAt + Math.max(1, term.length);
    }
  }

  if (!ranges.length) return [];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function tokenizeStrictSearchTerms(raw: string): string[] {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+/gu, '').replace(/[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length >= STRICT_TERM_MIN_LEN);
}

function buildEscapedHighlightedSnippet(content: string, q: string) {
  const raw = String(content || '');
  if (!raw) return '';

  const terms = tokenizeStrictSearchTerms(q);
  const ranges = buildHighlightRanges(raw, terms);
  const snippetMaxChars = 280;

  let start = 0;
  let end = raw.length;
  if (raw.length > snippetMaxChars) {
    if (ranges.length > 0) {
      const focusStart = ranges[0].start;
      start = Math.max(0, focusStart - 90);
      end = Math.min(raw.length, start + snippetMaxChars);
      if (end - start < snippetMaxChars) {
        start = Math.max(0, end - snippetMaxChars);
      }
    } else {
      end = Math.min(raw.length, snippetMaxChars);
    }
  }

  const visibleRanges = ranges
    .map((range) => ({
      start: Math.max(range.start, start),
      end: Math.min(range.end, end),
    }))
    .filter((range) => range.start < range.end);

  let formatted = start > 0 ? '…' : '';
  let cursor = start;
  for (const range of visibleRanges) {
    if (range.start > cursor) {
      formatted += escapeHtml(raw.slice(cursor, range.start));
    }
    formatted += `<em>${escapeHtml(raw.slice(range.start, range.end))}</em>`;
    cursor = range.end;
  }
  if (cursor < end) {
    formatted += escapeHtml(raw.slice(cursor, end));
  }
  if (end < raw.length) {
    formatted += '…';
  }
  return formatted;
}

function buildResult(rows: any[], q: string, offset: number, limit: number) {
  const materializedRows = rows.filter((row) => row && row.id);
  return {
    hits: materializedRows.map(row => ({
      id: row.id,
      content: row.content,
      authorId: row.authorId,
      authorDisplayName: row.authorDisplayName,
      channelId: row.channelId,
      conversationId: row.conversationId,
      communityId: row.communityId,
      channelName: row.channelName,
      createdAt: row.createdAt,
      _formatted: {
        content: row.highlight
          ? sanitizeHeadline(row.highlight)
          : buildEscapedHighlightedSnippet(row.content || '', q),
      },
    })),
    offset,
    limit,
    estimatedTotalHits: materializedRows.length,
    processingTimeMs: 0,
    query: q,
  };
}

function messageMatchesAllStrictTerms(content: unknown, terms: string[]): boolean {
  if (!terms.length) return true;
  const normalized = normalizeForStrictMatch(String(content || ''));
  const collapsed = collapseForStrictMatch(String(content || ''));
  return terms.every((t) => {
    const nt = normalizeForStrictMatch(t);
    if (normalized.includes(nt)) return true;
    // Fallback: collapsed comparison catches "ofcourse" vs "of course",
    // "dont" vs "don't" (already handled by normalize), etc.
    const ct = collapseForStrictMatch(t);
    if (ct.length >= 2 && collapsed.includes(ct)) return true;
    return false;
  });
}

module.exports = {
  tokenizeStrictSearchTerms,
  buildResult,
  messageMatchesAllStrictTerms,
};
