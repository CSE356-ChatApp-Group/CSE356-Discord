function createMeiliSearchExecutor({
  meiliClient,
  logger,
  runSearchQuery,
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
  function buildRecheckFromCandidates(
    ids: string[],
    q: string,
    opts: Record<string, any>,
  ) {
    const params: any[] = [];
    const scope = buildScopedAccessParts(params, opts);
    const idsPh = p(params, ids);
    const filters = buildFilters(params, opts);
    const limit = Number(opts.limit) || 20;
    const offset = Number(opts.offset) || 0;
    const limitPh = p(params, limit);
    const offsetPh = p(params, offset);

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
      meiliClient.incFallbackTotal();
      logger.warn(
        { err: { message: err?.message }, requestId, query: q, meili_ms: meiliMs },
        'search: meili candidate fetch failed, falling back to postgres',
      );
      throw createMeiliFallbackError('meili_unavailable');
    }
    const meiliMs = Date.now() - tMeili;
    const { ids } = candidateResult;

    if (ids.length === 0) {
      const totalMs = Date.now() - tAll;
      meiliClient.incFallbackTotal();
      logger.warn(
        {
          requestId,
          query: q,
          resolved_scope: scopeLabel,
          meili_candidate_count: 0,
          meili_ms: meiliMs,
          total_ms: totalMs,
        },
        'search: meili returned zero candidates, falling back to postgres',
      );
      throw createMeiliFallbackError('meili_empty_candidates');
    }

    const freshnessIds = await findFreshScopedSearchCandidateIds(q, opts);
    const mergedSet = new Set(ids || []);
    const freshnessArray = freshnessIds || [];
    for (const id of freshnessArray) {
      mergedSet.add(id);
    }
    const mergedIds = Array.from(mergedSet);

    const tRecheck = Date.now();
    const recheckMeta = buildRecheckFromCandidates(mergedIds, q, opts);
    const rows = await runSearchQuery(recheckMeta.sql, recheckMeta.params);
    const recheckMs = Date.now() - tRecheck;

    if (rows[0]?.__scopeAccess === false) {
      const err: any = new Error('Access denied');
      err.statusCode = 403;
      throw err;
    }

    const terms = tokenizeStrictSearchTerms(q);
    let strictRows = rows;
    if (terms.length > 0) {
      strictRows = rows.filter(
        (r: any) => r && r.id && messageMatchesAllStrictTerms(r.content, terms),
      );
    }

    const freshnessSupplementUsed = (() => {
      const idsSet = new Set(ids.map(String));
      return strictRows.some(
        (row: any) => row && row.id && !idsSet.has(String(row.id)),
      );
    })();

    if (freshnessSupplementUsed) {
      meiliClient.incFallbackTotal();
    }

    // Cache filtered rows for reuse
    const validRows = strictRows.filter((r: any) => r && r.id);
    const validRowsCount = validRows.length;

    if (validRowsCount === 0 && ids.length > 0) {
      meiliClient.incFallbackTotal();
      const totalMs = Date.now() - tAll;
      logger.warn(
        {
          search_trace: true,
          requestId,
          query: q,
          resolved_scope: scopeLabel,
          search_backend: 'meili',
          meili_candidate_count: ids.length,
          pg_fresh_candidate_count: freshnessIds.length,
          postgres_rechecked_count: rows.filter((r: any) => r && r.id).length,
          freshness_supplement_used: freshnessSupplementUsed,
          strict_term_count: terms.length,
          strict_pass_count: 0,
          reason: 'meili_strict_token_mismatch_fallback_postgres',
          meili_ms: meiliMs,
          postgres_recheck_ms: recheckMs,
          fallback_to_postgres: true,
          total_ms: totalMs,
        },
        'search_trace',
      );
      const initialForcePrimary = !searchUseReadReplica;
      return searchOnce(q, opts, initialForcePrimary);
    }

    const finalHits = validRows;
    const totalMs = Date.now() - tAll;

    logger.info(
      {
        search_trace: true,
        requestId,
        query: q,
        resolved_scope: scopeLabel,
        search_backend: 'meili',
        meili_candidate_count: ids.length,
        pg_fresh_candidate_count: freshnessIds.length,
        postgres_rechecked_count: rows.filter((r: any) => r && r.id).length,
        freshness_supplement_used: freshnessSupplementUsed,
        strict_term_count: terms.length,
        strict_pass_count: finalHits.length,
        final_hit_count: finalHits.length,
        meili_ms: meiliMs,
        postgres_recheck_ms: recheckMs,
        fallback_to_postgres: false,
        total_ms: totalMs,
      },
      'search_trace',
    );

    return buildResult(strictRows, recheckMeta.q, recheckMeta.offset, recheckMeta.limit);
  }

  return {
    searchWithMeiliBackend,
  };
}

module.exports = {
  createMeiliSearchExecutor,
};
