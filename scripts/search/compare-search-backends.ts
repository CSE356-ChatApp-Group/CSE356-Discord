import { createRequire } from 'module';

const requireCjs = createRequire(__filename);
const { searchWithOpenSearchBackend } = requireCjs('../../backend/src/search/opensearchExecution');
const meiliClient = requireCjs('../../backend/src/search/meiliClient');
const { buildResult } = requireCjs('../../backend/src/search/resultFormatting');
const { buildRecheckFromCandidates, applyStrictTermFilter } = requireCjs('../../backend/src/search/candidateRecheck');
const { runSearchReadOnlyQuery } = requireCjs('../../backend/src/search/searchExecution');

async function searchWithMeiliPoc(query: string, opts: Record<string, any>) {
  const candidates = await meiliClient.searchMessageCandidates(query, opts);
  if (!candidates.ids.length) return buildResult([], query, Number(opts.offset) || 0, Number(opts.limit) || 20);
  const recheck = buildRecheckFromCandidates(candidates.ids, query, opts, { pageInSql: false });
  const rows = await runSearchReadOnlyQuery(recheck.sql, recheck.params, {
    kind: 'compare_meili_recheck_query',
    forcePrimary: true,
  });
  const rechecked = rows.filter((row: any) => row && row.id);
  const strict = applyStrictTermFilter(rechecked, query);
  const final = strict.slice(recheck.offset, recheck.offset + recheck.limit);
  return {
    ids: final.map((row: any) => row.id),
    candidateCount: candidates.ids.length,
  };
}

async function searchWithOpenSearchPoc(query: string, opts: Record<string, any>) {
  const startedAt = Date.now();
  const result = await searchWithOpenSearchBackend(query, opts);
  return {
    ids: (result?.hits || []).map((hit: any) => hit.id),
    latencyMs: Date.now() - startedAt,
  };
}

async function main() {
  const scope = process.argv.includes('--conversationId')
    ? { conversationId: process.argv[process.argv.indexOf('--conversationId') + 1] }
    : { communityId: process.argv[process.argv.indexOf('--communityId') + 1] };
  const userId = process.argv[process.argv.indexOf('--userId') + 1];
  if (!userId || (!scope.communityId && !scope.conversationId)) {
    throw new Error('usage: tsx scripts/search/compare-search-backends.ts --userId <uuid> --communityId <uuid>');
  }

  const queries = ['check their rooms', 'silindiya itemler iade'];
  for (const query of queries) {
    const opts = { ...scope, userId, limit: 20, offset: 0 };

    const meiliStart = Date.now();
    const meili = await searchWithMeiliPoc(query, opts);
    const meiliLatencyMs = Date.now() - meiliStart;

    const open = await searchWithOpenSearchPoc(query, opts);
    const meiliSet = new Set(meili.ids);
    const openSet = new Set(open.ids);
    const overlap = open.ids.filter((id: string) => meiliSet.has(id));
    const meiliOnly = meili.ids.filter((id: string) => !openSet.has(id));
    const openOnly = open.ids.filter((id: string) => !meiliSet.has(id));

    console.log(
      JSON.stringify(
        {
          query,
          meili: { latencyMs: meiliLatencyMs, finalCount: meili.ids.length, candidateCount: meili.candidateCount },
          opensearch: { latencyMs: open.latencyMs, finalCount: open.ids.length },
          overlapCount: overlap.length,
          meiliOnlyCount: meiliOnly.length,
          opensearchOnlyCount: openOnly.length,
          sampleDiff: { meiliOnly: meiliOnly.slice(0, 10), opensearchOnly: openOnly.slice(0, 10) },
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
