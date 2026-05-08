const {
  runSearchReadOnlyQuery,
  runSearchQuery,
} = require('./searchExecution');
const { SEARCH_RECHECK_USE_READ_REPLICA } = require('./searchQueryEnv');
const {
  buildResult,
} = require('./resultFormatting');
const {
  buildRecheckFromCandidates,
  applyStrictTermFilter,
} = require('./candidateRecheck');
const {
  opensearchFetch,
  OPENSEARCH_INDEX_MESSAGES,
} = require('./opensearchClient');

function buildOpenSearchQuery(q: string, opts: Record<string, any>) {
  const rawMax = parseInt(process.env.OPENSEARCH_MAX_CANDIDATES || '250', 10);
  const maxCandidates = Math.min(Math.max(Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 250, 50), 2000);
  const filters: any[] = [{ term: { isDeleted: false } }];
  if (opts.communityId) {
    filters.push({ term: { communityId: String(opts.communityId) } });
  } else if (opts.conversationId) {
    filters.push({ term: { conversationId: String(opts.conversationId) } });
  }
  if (opts.authorId) {
    filters.push({ term: { authorId: String(opts.authorId) } });
  }
  if (opts.after || opts.before) {
    const range: Record<string, string> = {};
    if (opts.after) range.gte = new Date(String(opts.after)).toISOString();
    if (opts.before) range.lte = new Date(String(opts.before)).toISOString();
    filters.push({ range: { createdAt: range } });
  }
  return {
    size: maxCandidates,
    from: 0,
    _source: ['id'],
    query: {
      bool: {
        must: q ? [{ match: { content: { query: String(q), operator: 'and' } } }] : [{ match_all: {} }],
        filter: filters,
      },
    },
    sort: [{ createdAt: { order: 'desc' } }, { id: { order: 'desc' } }],
  };
}

async function searchOpenSearchCandidates(
  q: string,
  opts: Record<string, any> = {},
): Promise<{ ids: string[]; estimatedTotal: number }> {
  const body = buildOpenSearchQuery(q, opts);
  const res = await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}/_search`, {
    method: 'POST',
    body,
  });
  const hits = Array.isArray(res?.hits?.hits) ? res.hits.hits : [];
  const ids = hits
    .map((hit: any) => String(hit?._source?.id || hit?._id || ''))
    .filter(Boolean);
  const estimatedTotal = Number(res?.hits?.total?.value || ids.length);
  return { ids, estimatedTotal };
}

async function runCandidateRecheck(sql: string, params: any[]) {
  if (runSearchReadOnlyQuery) {
    return runSearchReadOnlyQuery(sql, params, {
      kind: 'opensearch_recheck_query',
      forcePrimary: !SEARCH_RECHECK_USE_READ_REPLICA,
    });
  }
  return runSearchQuery(sql, params, { forcePrimary: !SEARCH_RECHECK_USE_READ_REPLICA });
}

async function searchWithOpenSearchBackend(
  q: string,
  opts: Record<string, any> = {},
): Promise<any> {
  const candidates = await searchOpenSearchCandidates(q, opts);
  if (!candidates.ids.length) {
    return buildResult([], q, Number(opts.offset) || 0, Number(opts.limit) || 20);
  }
  const recheckMeta = buildRecheckFromCandidates(candidates.ids, q, opts, { pageInSql: false });
  const rows = await runCandidateRecheck(recheckMeta.sql, recheckMeta.params);
  if (rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
  const recheckedRows = rows.filter((row: any) => row && row.id);
  const strictHits = applyStrictTermFilter(recheckedRows, q);
  const finalHits = strictHits.slice(recheckMeta.offset, recheckMeta.offset + recheckMeta.limit);
  return buildResult(finalHits, recheckMeta.q, recheckMeta.offset, recheckMeta.limit);
}

module.exports = {
  buildOpenSearchQuery,
  searchOpenSearchCandidates,
  searchWithOpenSearchBackend,
};
