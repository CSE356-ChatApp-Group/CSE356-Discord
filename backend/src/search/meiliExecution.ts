function createMeiliSearchExecutor({
  meiliClient,
  logger,
  runSearchQuery,
  runSearchReadOnlyQuery,
  findFreshScopedSearchCandidateIds,
  resolvedSearchScope,
  buildScopedAccessParts,
  p,
  buildFilters,
  SELECT_COLS,
  FROM_CLAUSE,
  tokenizeStrictSearchTerms,
  messageMatchesAllStrictTerms,
  buildResult,
  createMeiliFallbackError,
  searchUseReadReplica,
  searchOnce,
}) {
  const {
    meiliRecheckDurationMs,
    searchFreshnessRescueWallDurationMs,
  } = require('../utils/metrics/searchPerformance');
  const {
    SEARCH_RECHECK_USE_READ_REPLICA,
  } = require('./searchQueryEnv');

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

  async function searchWithMeiliBackend(
    q: string,
    opts: Record<string, any> = {},
  ): Promise<any> {
    const tAll = Date.now();
    const requestId = opts.requestId != null ? String(opts.requestId) : undefined;
    const scopeLabel = resolvedSearchScope(opts);

    const tMeili = Date.now();
    let candidateResult: { ids: string[]; estimatedTotal: number };
    try {
      candidateResult = await meiliClient.searchMessageCandidates(q, opts);
    } catch (err: any) {
      const meiliMs = Date.now() - tMeili;
      meiliClient.incFallbackTotal('unavailable');
      logger.warn(
        { err: { message: err?.message }, requestId, query: q, meili_ms: meiliMs },
        'search: meili candidate fetch failed, falling back to postgres',
      );
      throw createMeiliFallbackError('meili_unavailable');
    }
    const meiliMs = Date.now() - tMeili;
    const { ids } = candidateResult;

    if (ids.length === 0) {
      // Meili returned no candidates — try freshness rescue before falling back to
      // full Postgres FTS. Freshness is started here (not pre-emptively on every
      // search) so it adds zero latency on the happy path. The sequential cost on
      // this rare rescue path is acceptable given empty_candidates fires infrequently.
      let freshnessIds: string[] = [];
      const tFreshnessRescue = Date.now();
      try {
        freshnessIds = await findFreshScopedSearchCandidateIds(q, opts);
      } catch (err: unknown) {
        logger.debug({ err }, 'search freshness rescue query failed');
      }

      if (freshnessIds.length > 0) {
        const tRecheck = Date.now();
        const recheckMeta = buildRecheckFromCandidates(freshnessIds, q, opts);
        const rows = await runMeiliRecheckQuery(recheckMeta.sql, recheckMeta.params);
        const recheckMs = Date.now() - tRecheck;
        meiliRecheckDurationMs.observe({ source: 'freshness', backend: recheckBackendLabel() }, recheckMs);

        if (rows[0]?.__scopeAccess === false) {
          const err: any = new Error('Access denied');
          err.statusCode = 403;
          throw err;
        }

        const strictTerms = tokenizeStrictSearchTerms(q);
        const recheckedRows = rows.filter((r: any) => r && r.id);
        const finalHits = strictTerms.length > 0
          ? recheckedRows.filter((r: any) => messageMatchesAllStrictTerms(r.content, strictTerms))
          : recheckedRows;
        const totalMs = Date.now() - tAll;

        if (finalHits.length > 0) {
          searchFreshnessRescueWallDurationMs.observe(
            { result: 'rescued' },
            Date.now() - tFreshnessRescue,
          );
          logger.info(
            {
              search_trace: true,
              requestId,
              query: q,
              resolved_scope: scopeLabel,
              search_backend: 'meili',
              meili_candidate_count: 0,
              pg_fresh_candidate_count: freshnessIds.length,
              postgres_rechecked_count: recheckedRows.length,
              freshness_rescued: true,
              strict_term_count: strictTerms.length,
              strict_pass_count: finalHits.length,
              final_hit_count: finalHits.length,
              meili_ms: meiliMs,
              postgres_recheck_ms: recheckMs,
              fallback_to_postgres: false,
              total_ms: totalMs,
            },
            'search_trace',
          );

          return buildResult(finalHits, recheckMeta.q, recheckMeta.offset, recheckMeta.limit);
        }
      }

      const totalMs = Date.now() - tAll;
      searchFreshnessRescueWallDurationMs.observe(
        { result: 'empty' },
        Date.now() - tFreshnessRescue,
      );
      meiliClient.incFallbackTotal('empty_candidates');
      logger.warn(
        {
          requestId,
          query: q,
          resolved_scope: scopeLabel,
          meili_candidate_count: 0,
          pg_fresh_candidate_count: 0,
          meili_ms: meiliMs,
          total_ms: totalMs,
        },
        'search: meili returned zero candidates, falling back to postgres',
      );
      throw createMeiliFallbackError('meili_empty_candidates');
    }

    // Happy path: Meili returned candidates. Recheck directly — no freshness supplement.
    // Running freshness on every search added ~400ms to p95 with 0% cache hit rate;
    // the supplement benefit (catching edits before re-indexing) doesn't justify the cost.
    const tRecheck = Date.now();
    const recheckMeta = buildRecheckFromCandidates(ids, q, opts, { pageInSql: false });
    const rows = await runMeiliRecheckQuery(recheckMeta.sql, recheckMeta.params);
    const recheckMs = Date.now() - tRecheck;
    meiliRecheckDurationMs.observe({ source: 'meili', backend: recheckBackendLabel() }, recheckMs);

    if (rows[0]?.__scopeAccess === false) {
      const err: any = new Error('Access denied');
      err.statusCode = 403;
      throw err;
    }

    // Meili is a candidate generator. Postgres has now fetched the latest
    // content, so enforce the API's exact all-term contract before returning.
    const recheckedRows = rows.filter((r: any) => r && r.id);
    const strictTerms = tokenizeStrictSearchTerms(q);
    const strictHits = strictTerms.length > 0
      ? recheckedRows.filter((r: any) => messageMatchesAllStrictTerms(r.content, strictTerms))
      : recheckedRows;
    const finalHits = strictHits.slice(recheckMeta.offset, recheckMeta.offset + recheckMeta.limit);
    const totalMs = Date.now() - tAll;

    if (ids.length > 0 && recheckedRows.length > 0 && strictHits.length === 0) {
      meiliClient.incFallbackTotal('strict_token_mismatch');
      logger.warn(
        {
          search_trace: true,
          requestId,
          query: q,
          resolved_scope: scopeLabel,
          search_backend: 'meili',
          meili_candidate_count: ids.length,
          postgres_rechecked_count: recheckedRows.length,
          strict_term_count: strictTerms.length,
          strict_pass_count: strictHits.length,
          reason: 'meili_strict_token_mismatch_fallback_postgres',
          meili_ms: meiliMs,
          postgres_recheck_ms: recheckMs,
          fallback_to_postgres: true,
          total_ms: totalMs,
        },
        'search_trace',
      );
      return searchOnce(q, opts, !searchUseReadReplica);
    }

    logger.info(
      {
        search_trace: true,
        requestId,
        query: q,
        resolved_scope: scopeLabel,
        search_backend: 'meili',
        meili_candidate_count: ids.length,
        postgres_rechecked_count: recheckedRows.length,
        strict_term_count: strictTerms.length,
        strict_pass_count: finalHits.length,
        final_hit_count: finalHits.length,
        meili_ms: meiliMs,
        postgres_recheck_ms: recheckMs,
        fallback_to_postgres: false,
        total_ms: totalMs,
      },
      'search_trace',
    );

    return buildResult(finalHits, recheckMeta.q, recheckMeta.offset, recheckMeta.limit);
  }

  function runMeiliRecheckQuery(sql: string, params: any[]) {
    if (runSearchReadOnlyQuery) {
      return runSearchReadOnlyQuery(sql, params, {
        kind: 'meili_recheck_query',
        forcePrimary: !SEARCH_RECHECK_USE_READ_REPLICA,
      });
    }
    return runSearchQuery(sql, params, { forcePrimary: !SEARCH_RECHECK_USE_READ_REPLICA });
  }

  function recheckBackendLabel() {
    return SEARCH_RECHECK_USE_READ_REPLICA ? 'read' : 'primary';
  }

  return {
    searchWithMeiliBackend,
  };
}

module.exports = {
  createMeiliSearchExecutor,
};
