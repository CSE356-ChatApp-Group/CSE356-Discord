const {
  SELECT_COLS,
  FROM_CLAUSE,
  buildScopedAccessParts,
  buildFilters,
  p,
} = require('./sqlParts');
const {
  tokenizeStrictSearchTerms,
  messageMatchesAllStrictTerms,
} = require('./resultFormatting');
const { stripEnglishStopWords } = require('./stopWords');

function buildRecheckFromCandidates(
  ids: string[],
  q: string,
  opts: Record<string, any>,
  options: { pageInSql?: boolean } = {},
) {
  const params: any[] = [];
  const scope = buildScopedAccessParts(params, opts);
  const idsPh = p(params, ids);
  const filters = buildFilters(params, opts);
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const pageInSql = options.pageInSql !== false;
  const sqlLimit = pageInSql ? limit : Math.max(limit, ids.length);
  const sqlOffset = pageInSql ? offset : 0;
  const limitPh = p(params, sqlLimit);
  const offsetPh = p(params, sqlOffset);

  const sql = `
    WITH candidates AS (
      SELECT unnest(${idsPh}::uuid[]) AS id
    )
    ${scope ? `, ${scope.cte.trim()}` : ''}
    SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
      recheck_rows.*
    ${scope ? scope.fromClause : 'FROM'}
    ${scope ? 'LEFT JOIN LATERAL (' : '('}
      SELECT ${SELECT_COLS}
      ${FROM_CLAUSE}
      JOIN candidates c ON c.id = m.id
      WHERE m.deleted_at IS NULL
        ${filters}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) recheck_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

function applyStrictTermFilter(rows: any[], q: string): any[] {
  const strictTerms = tokenizeStrictSearchTerms(stripEnglishStopWords(q));
  if (!strictTerms.length) return rows;
  return rows.filter((row: any) => messageMatchesAllStrictTerms(row.content, strictTerms));
}

module.exports = {
  buildRecheckFromCandidates,
  applyStrictTermFilter,
};
