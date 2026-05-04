/**
 * Search client – Postgres native full-text search (FTS primary).
 *
 * Primary path:  websearch_to_tsquery + tsvector GIN index
 *                with application-side highlighting/snippet formatting
 *
 * Scoped searches only (community or DM conversation), per spec §7: community
 * search spans accessible public and private channels; conversation search is
 * limited to that thread. If FTS returns no rows, a bounded literal substring
 * pass runs inside the same scope (no trigram, no cross-scope scan).
 *
 * Access control is built into the query:
 *   - `scope_access` CTE preserves 403 without a second DB trip.
 *   - FTS candidate generation applies the same access rules as `scope_access`
 *     before ORDER BY / LIMIT on hot paths (community channels, channel privacy,
 *     conversation participation).
 */


const db = require('../db/pool');
const logger = require('../utils/logger');
const meiliClient = require('./meiliClient');
const redis = require('../db/redis');
const {
  searchFreshnessQueryDurationMs,
  searchFreshnessCacheHitsTotal,
  searchFreshnessCacheMissesTotal,
  searchFreshnessSkippedShortQueryTotal,
} = require('../utils/metrics/searchPerformance');
const {
  tokenizeStrictSearchTerms,
  buildResult,
  messageMatchesAllStrictTerms,
} = require('./resultFormatting');
const {
  SELECT_COLS,
  SELECT_COLS_FROM_SCOPED_CANDIDATE,
  FROM_CLAUSE,
  FTS_FROM_CLAUSE,
  p,
  buildScopedAccessParts,
  buildAuthorTimeFilters,
  buildFilters,
  buildStrictLiteralPredicate,
} = require('./sqlParts');
const { createSearchRetryPolicy } = require('./retryPolicy');
const { createMeiliSearchExecutor } = require('./meiliExecution');
const { mergeSearchRowsPreferLiteral } = require('./resultMerge');
const {
  resolvedSearchScope,
  logSearchTrace,
  buildBaseSearchTracePayload,
  buildCommunityTraceFields,
} = require('./searchTracing');
const {
  SEARCH_USE_READ_REPLICA,
  literalRecentCandidateCap,
  literalRecentCandidateCapDeep,
  ftsRecentCandidateCapDeep,
  meiliFreshnessWindowMs,
  meiliFreshnessCandidateCap,
} = require('./searchQueryEnv');
const {
  runSearchQuery,
  runSearchTransaction,
} = require('./searchExecution');

function isScopedSearch(opts: Record<string, any>): boolean {
  return Boolean(opts.communityId || opts.conversationId);
}

function throwIfScopeDenied(rows: any[]) {
  if (rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
}

function ftsRecentCandidateCap(limit: number, offset: number): number {
  const raw = parseInt(process.env.SEARCH_FTS_RECENT_CANDIDATES_LIMIT || '800', 10);
  const minNeeded = Math.max(offset + limit, limit);
  const clamped = Math.min(
    Math.max(Number.isFinite(raw) && raw > 0 ? raw : 800, 500),
    1000,
  );
  return Math.max(clamped, minNeeded);
}

/** Statement + paging metadata for FTS (content_tsv GIN). */
function buildFtsParts(
  q: string,
  opts: Record<string, any>,
  recentCandidatesLimitOverride?: number,
) {
  const params: any[] = [q]; // $1 reserved for the query string
  const scope = buildScopedAccessParts(params, opts);
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const ctes = [`search_query AS (SELECT websearch_to_tsquery('english', $1) AS q)`];
  if (scope) ctes.push(scope.cte.trim());

  // Bound the scoped working set before FTS candidate evaluation work.
  const recentCandidatesLimit =
    Number.isFinite(recentCandidatesLimitOverride as number) &&
    (recentCandidatesLimitOverride as number) > 0
      ? Number(recentCandidatesLimitOverride)
      : ftsRecentCandidateCap(limit, offset);

  const candidateFilters: string[] = [];
  if (opts.authorId) candidateFilters.push(`AND m0.author_id = ${p(params, opts.authorId)}`);
  if (opts.after)    candidateFilters.push(`AND m0.created_at >= ${p(params, opts.after)}::timestamptz`);
  if (opts.before)   candidateFilters.push(`AND m0.created_at <= ${p(params, opts.before)}::timestamptz`);

  const isCommunityScoped = scope?.scopeType === 'community';
  let filters = '';
  let selectCols = SELECT_COLS;
  let finalFromClause = `${FTS_FROM_CLAUSE}\n      JOIN fts_candidates fc ON fc.id = m.id`;
  let orderBy = 'fc.created_at DESC, m.id DESC';

  if (!scope) {
    throw new Error('FTS search requires communityId or conversationId');
  }

  if (isCommunityScoped && scope?.targetIdPh && scope?.userIdPh) {
    ctes.push(`community_channels AS MATERIALIZED (
      SELECT ch.id,
             ch.community_id,
             ch.name
      FROM channels ch
      LEFT JOIN channel_members cm
        ON cm.channel_id = ch.id
       AND cm.user_id = ${scope.userIdPh}
      WHERE ch.community_id = ${scope.targetIdPh}
        AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)
    )`);

    ctes.push(`scoped_recent_candidates AS MATERIALIZED (
      SELECT m0.id,
             m0.created_at,
             m0.channel_id
      FROM messages m0
      INNER JOIN community_channels cc0
        ON cc0.id = m0.channel_id
      WHERE m0.deleted_at IS NULL
        ${candidateFilters.join('\n        ')}
      ORDER BY m0.created_at DESC, m0.id DESC
      LIMIT ${recentCandidatesLimit}
    )`);

    ctes.push(`fts_candidates AS MATERIALIZED (
      SELECT src.id,
             src.created_at,
             src.channel_id
      FROM scoped_recent_candidates src
      CROSS JOIN search_query sq0
      JOIN messages m0 ON m0.id = src.id
      WHERE m0.content_tsv @@ sq0.q
      ORDER BY src.created_at DESC, src.id DESC
    )`);

    ctes.push(`fts_candidate_stats AS (
      SELECT COUNT(*)::int AS fts_candidate_count FROM scoped_recent_candidates
    )`);

    ctes.push(`scoped_candidates AS MATERIALIZED (
      SELECT fc.id,
             fc.created_at,
             fc.channel_id,
             cc.community_id,
             cc.name AS channel_name
      FROM fts_candidates fc
      JOIN community_channels cc ON cc.id = fc.channel_id
      ORDER BY fc.created_at DESC, fc.id DESC
      LIMIT ${recentCandidatesLimit}
    )`);

    selectCols = SELECT_COLS_FROM_SCOPED_CANDIDATE;
    finalFromClause = `
      FROM scoped_candidates sc
      JOIN messages m ON m.id = sc.id
      CROSS JOIN search_query sq
      JOIN users u ON u.id = m.author_id`;
    orderBy = 'sc.created_at DESC, m.id DESC';
  } else if (scope.scopeType === 'conversation' && scope.targetIdPh && scope.userIdPh) {
    ctes.push(`scoped_recent_candidates AS MATERIALIZED (
      SELECT m0.id,
             m0.created_at
      FROM messages m0
      INNER JOIN conversation_participants cp_gate
        ON cp_gate.conversation_id = m0.conversation_id
       AND cp_gate.conversation_id = ${scope.targetIdPh}
       AND cp_gate.user_id = ${scope.userIdPh}
       AND cp_gate.left_at IS NULL
      WHERE m0.deleted_at IS NULL
        AND m0.conversation_id = ${scope.targetIdPh}
        ${candidateFilters.join('\n        ')}
      ORDER BY m0.created_at DESC, m0.id DESC
      LIMIT ${recentCandidatesLimit}
    )`);
    ctes.push(`fts_candidates AS MATERIALIZED (
      SELECT src.id,
             src.created_at
      FROM scoped_recent_candidates src
      CROSS JOIN search_query sq0
      JOIN messages m0 ON m0.id = src.id
      WHERE m0.content_tsv @@ sq0.q
      ORDER BY src.created_at DESC, src.id DESC
    )`);
    filters = '';
  } else {
    throw new Error(`Unsupported FTS scope: ${scope.scopeType}`);
  }

  const limitPh = p(params, limit);
  const offsetPh = p(params, offset);

  const useCommunityFtsStats =
    Boolean(isCommunityScoped && scope?.targetIdPh && scope?.userIdPh);
  const scopeFromSql = scope
    ? useCommunityFtsStats
      ? `${scope.fromClause} CROSS JOIN fts_candidate_stats fstats`
      : scope.fromClause
    : 'FROM';

  const sql = `
    WITH ${ctes.join(',\n')}
    SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}${
      useCommunityFtsStats ? 'fstats.fts_candidate_count AS fts_candidate_count,' : ''
    }
      search_rows.*
    ${scopeFromSql}
    ${scope ? 'LEFT JOIN LATERAL (' : '('}
      SELECT ${selectCols}
      ${finalFromClause}
      WHERE m.deleted_at IS NULL
        AND m.content_tsv @@ sq.q
        ${filters}
      ORDER BY ${orderBy}
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

function buildScopedLiteralParts(
  q: string,
  opts: Record<string, any>,
  strictTerms: string[] = [],
  recentCapOverride?: number,
) {
  const params: any[] = [];
  const scope = buildScopedAccessParts(params, opts);
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;

  if (!scope) {
    return {
      sql: `SELECT NULL WHERE FALSE`,
      params,
      limit,
      offset,
      q,
    };
  }

  // Parameter order must match SQL text: scope ids (in CTE), author/time, query string,
  // scoped candidate cap, page limit, offset.
  const authorTimeFilters = buildAuthorTimeFilters(params, opts, 'm0');
  const normalizedStrictTerms = Array.from(
    new Set(
      (strictTerms || [])
        .map((t) => String(t || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const strictMultiWord = normalizedStrictTerms.length > 1;
  const rawQueryPh = !strictMultiWord ? p(params, q) : '';
  const strictTermLikePhs = strictMultiWord ? normalizedStrictTerms.map((t) => p(params, t)) : [];
  const scopedRecentCap = Number.isFinite(recentCapOverride as number) && (recentCapOverride as number) > 0
    ? Number(recentCapOverride)
    : literalRecentCandidateCap();
  const recentCapPh = p(params, scopedRecentCap);
  const limitPh = p(params, limit);
  const offsetPh = p(params, offset);
  const communityStrictPredicate = buildStrictLiteralPredicate(
    'mc.content',
    strictMultiWord,
    strictTermLikePhs,
    rawQueryPh,
  );
  const conversationStrictPredicate = buildStrictLiteralPredicate(
    'm.content',
    strictMultiWord,
    strictTermLikePhs,
    rawQueryPh,
  );

  if (scope.scopeType === 'community') {
    return {
      sql: `
        WITH ${scope.cte.trim()},
        community_channels AS MATERIALIZED (
          SELECT ch.id,
                 ch.community_id,
                 ch.name
          FROM channels ch
          LEFT JOIN channel_members cm
            ON cm.channel_id = ch.id
           AND cm.user_id = ${scope.userIdPh}
          WHERE ch.community_id = ${scope.targetIdPh}
            AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)
        ),
        community_candidates AS MATERIALIZED (
          SELECT m0.id,
                 m0.content,
                 m0.author_id,
                 m0.channel_id,
                 m0.conversation_id,
                 m0.created_at
          FROM messages m0
          INNER JOIN community_channels cc0
            ON cc0.id = m0.channel_id
          WHERE m0.deleted_at IS NULL
            ${authorTimeFilters}
          ORDER BY m0.created_at DESC, m0.id DESC
          LIMIT ${recentCapPh}
        )
        SELECT scope_access.has_access AS "__scopeAccess",
          search_rows.*
        FROM scope_access
        LEFT JOIN LATERAL (
          SELECT mc.id,
                 mc.content,
                 mc.author_id        AS "authorId",
                 COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
                 mc.channel_id       AS "channelId",
                 mc.conversation_id  AS "conversationId",
                 mc.created_at       AS "createdAt",
                 cc.community_id    AS "communityId",
                 cc.name            AS "channelName"
          FROM community_candidates mc
          JOIN community_channels cc
            ON cc.id = mc.channel_id
          JOIN users u ON u.id = mc.author_id
          WHERE ${communityStrictPredicate}
          ORDER BY mc.created_at DESC, mc.id DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ON scope_access.has_access = TRUE`,
      params,
      limit,
      offset,
      q,
    };
  }

  if (scope.scopeType === 'conversation' && scope.targetIdPh && scope.userIdPh) {
    return {
      sql: `
        WITH ${scope.cte.trim()}
        SELECT scope_access.has_access AS "__scopeAccess",
          search_rows.*
        FROM scope_access
        LEFT JOIN LATERAL (
          SELECT ${SELECT_COLS}
          FROM (
            SELECT m0.id,
                   m0.content,
                   m0.author_id,
                   m0.channel_id,
                   m0.conversation_id,
                   m0.created_at
            FROM messages m0
            INNER JOIN conversation_participants cp_gate
              ON cp_gate.conversation_id = m0.conversation_id
             AND cp_gate.conversation_id = ${scope.targetIdPh}
             AND cp_gate.user_id = ${scope.userIdPh}
             AND cp_gate.left_at IS NULL
            WHERE m0.deleted_at IS NULL
              AND m0.conversation_id = ${scope.targetIdPh}
              ${authorTimeFilters}
            ORDER BY m0.created_at DESC, m0.id DESC
            LIMIT ${recentCapPh}
          ) m
          JOIN users u ON u.id = m.author_id
          LEFT JOIN channels ch ON ch.id = m.channel_id
          WHERE ${conversationStrictPredicate}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ON scope_access.has_access = TRUE`,
      params,
      limit,
      offset,
      q,
    };
  }

  return {
    sql: `SELECT NULL WHERE FALSE`,
    params,
    limit,
    offset,
    q,
  };
}

async function searchFilteredOnly(
  opts: Record<string, any>,
  forcePrimary = false,
): Promise<any> {
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  if (!isScopedSearch(opts)) {
    return buildResult([], '', offset, limit);
  }

  const params: any[] = [];
  const scope = buildScopedAccessParts(params, opts);
  const filters  = buildFilters(params, opts);
  const limitPh  = p(params, limit);
  const offsetPh = p(params, offset);

  const sql = `
    ${scope ? `WITH ${scope.cte}` : ''}
    SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
      search_rows.*
    ${scope ? scope.fromClause : 'FROM'}
    ${scope ? 'LEFT JOIN LATERAL (' : '('}
      SELECT ${SELECT_COLS}
      ${FROM_CLAUSE}
      WHERE m.deleted_at IS NULL
        ${filters}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  const rows = await runSearchQuery(sql, params, { forcePrimary });
  if (scope && rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
  return buildResult(rows, '', offset, limit);
}

async function findFreshScopedSearchCandidateIds(
  q: string,
  opts: Record<string, any> = {},
): Promise<string[]> {
  const trimmed = String(q || '').trim();
  if (!trimmed || !isScopedSearch(opts)) return [];

  // Skip freshness supplement for very short queries (< 3 chars: high recall, low latency trade-off)
  if (trimmed.length < 3) {
    searchFreshnessSkippedShortQueryTotal.inc();
    return [];
  }

  // Try Redis cache first (5-second TTL)
  const cacheKey = `search:fresh:${opts.communityId || opts.conversationId}:${opts.userId}:${trimmed.substring(0, 50)}`;
  let cached: string | null = null;
  let cacheReadFailed = false;
  try {
    cached = await redis.get(cacheKey);
  } catch (err: any) {
    cacheReadFailed = true;
    searchFreshnessCacheMissesTotal.inc({ reason: 'read_error' });
    logger.debug({ err: { message: err?.message }, cacheKey }, 'search: freshness cache read failed');
    // Continue to query if cache read fails
  }

  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) {
        searchFreshnessCacheHitsTotal.inc();
        return parsed;
      }
      searchFreshnessCacheMissesTotal.inc({ reason: 'invalid_shape' });
    } catch (err: any) {
      searchFreshnessCacheMissesTotal.inc({ reason: 'parse_error' });
      logger.debug({ err: { message: err?.message }, cacheKey }, 'search: freshness cache parse failed');
    }
  } else if (!cacheReadFailed) {
    searchFreshnessCacheMissesTotal.inc({ reason: 'empty' });
  }

  const tStart = Date.now();
  const params: any[] = [trimmed];
  const scope = buildScopedAccessParts(params, opts);
  if (!scope) return [];

  const strictTerms = tokenizeStrictSearchTerms(trimmed);
  const strictMultiWord = strictTerms.length > 1;
  const rawQueryPh = !strictMultiWord ? p(params, trimmed) : '';
  const strictTermLikePhs = strictMultiWord ? strictTerms.map((term) => p(params, term)) : [];
  const freshnessWindowMsPh = p(params, meiliFreshnessWindowMs());
  const freshnessCapPh = p(params, meiliFreshnessCandidateCap());
  const authorTimeFilters = buildAuthorTimeFilters(params, opts, 'm0');
  const strictPredicate = buildStrictLiteralPredicate(
    'fresh.content',
    strictMultiWord,
    strictTermLikePhs,
    rawQueryPh,
  );

  let sql = '';
  if (scope.scopeType === 'community' && scope.targetIdPh && scope.userIdPh) {
    sql = `
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', $1) AS q,
               numnode(websearch_to_tsquery('english', $1)) AS tsquery_nodes
      ),
      ${scope.cte.trim()},
      community_channels AS MATERIALIZED (
        SELECT ch.id,
               ch.community_id,
               ch.name
        FROM channels ch
        LEFT JOIN channel_members cm
          ON cm.channel_id = ch.id
         AND cm.user_id = ${scope.userIdPh}
        WHERE ch.community_id = ${scope.targetIdPh}
          AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)
      ),
      recent_changed AS MATERIALIZED (
        SELECT m0.id,
               m0.content,
               m0.content_tsv,
               COALESCE(m0.updated_at, m0.created_at) AS freshness_at
        FROM messages m0
        INNER JOIN community_channels cc0
          ON cc0.id = m0.channel_id
        WHERE m0.deleted_at IS NULL
          AND COALESCE(m0.updated_at, m0.created_at) >= NOW() - (${freshnessWindowMsPh}::int * interval '1 millisecond')
          ${authorTimeFilters}
        ORDER BY COALESCE(m0.updated_at, m0.created_at) DESC, m0.id DESC
        LIMIT ${freshnessCapPh}
      )
      SELECT scope_access.has_access AS "__scopeAccess",
        fresh_rows.id
      FROM scope_access
      LEFT JOIN LATERAL (
        SELECT fresh.id
        FROM recent_changed fresh
        CROSS JOIN search_query sq
        WHERE (
          (sq.tsquery_nodes > 0 AND fresh.content_tsv @@ sq.q)
          OR ${strictPredicate}
        )
        ORDER BY fresh.freshness_at DESC, fresh.id DESC
        LIMIT ${freshnessCapPh}
      ) fresh_rows ON scope_access.has_access = TRUE`;
  } else if (scope.scopeType === 'conversation' && scope.targetIdPh && scope.userIdPh) {
    sql = `
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', $1) AS q,
               numnode(websearch_to_tsquery('english', $1)) AS tsquery_nodes
      ),
      ${scope.cte.trim()},
      recent_changed AS MATERIALIZED (
        SELECT m0.id,
               m0.content,
               m0.content_tsv,
               COALESCE(m0.updated_at, m0.created_at) AS freshness_at
        FROM messages m0
        INNER JOIN conversation_participants cp_gate
          ON cp_gate.conversation_id = m0.conversation_id
         AND cp_gate.conversation_id = ${scope.targetIdPh}
         AND cp_gate.user_id = ${scope.userIdPh}
         AND cp_gate.left_at IS NULL
        WHERE m0.deleted_at IS NULL
          AND m0.conversation_id = ${scope.targetIdPh}
          AND COALESCE(m0.updated_at, m0.created_at) >= NOW() - (${freshnessWindowMsPh}::int * interval '1 millisecond')
          ${authorTimeFilters}
        ORDER BY COALESCE(m0.updated_at, m0.created_at) DESC, m0.id DESC
        LIMIT ${freshnessCapPh}
      )
      SELECT scope_access.has_access AS "__scopeAccess",
        fresh_rows.id
      FROM scope_access
      LEFT JOIN LATERAL (
        SELECT fresh.id
        FROM recent_changed fresh
        CROSS JOIN search_query sq
        WHERE (
          (sq.tsquery_nodes > 0 AND fresh.content_tsv @@ sq.q)
          OR ${strictPredicate}
        )
        ORDER BY fresh.freshness_at DESC, fresh.id DESC
        LIMIT ${freshnessCapPh}
      ) fresh_rows ON scope_access.has_access = TRUE`;
  } else {
    return [];
  }

  const rows = await runSearchQuery(sql, params, { forcePrimary: true });
  if (rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
  const resultIds = rows.filter((row: any) => row && row.id).map((row: any) => String(row.id));
  const elapsedMs = Date.now() - tStart;
  
  // Cache fresh candidate results for 5 seconds
  try {
    await redis.setex(cacheKey, 5, JSON.stringify(resultIds));
  } catch (err: any) {
    logger.debug({ err: { message: err?.message }, cacheKey }, 'search: freshness cache write failed');
    // Non-fatal: continue on cache write failure
  }
  
  // Record timing metric for freshness query
  searchFreshnessQueryDurationMs.observe(elapsedMs);
  
  return resultIds;
}

const {
  shouldRetrySearchOnPrimary,
  logPrimaryRetry,
  createMeiliFallbackError,
} = createSearchRetryPolicy({
  logger,
  searchUseReadReplica: SEARCH_USE_READ_REPLICA,
  hasReadPool: Boolean(db.readPool),
});

/**
 * search – main entry point. FTS-only.
 *
 * Scoped searches run FTS first. When FTS returns no hits, a bounded literal
 * substring match runs inside the same scope (no trigram, no cross-scope scan).
 * Queries without communityId or conversationId return no hits.
 *
 * @param q     Raw query string (validated by caller: non-empty when present)
 * @param opts  { conversationId?, communityId?, userId, authorId?, after?, before?, limit?, offset?, requestId? }
 */
async function searchOnce(
  q: string,
  opts: Record<string, any> = {},
  forcePrimary = false,
): Promise<any> {
  if (!String(q || '').trim()) {
    return searchFilteredOnly(opts, forcePrimary);
  }

  const trimmed = String(q).trim();
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  if (!isScopedSearch(opts)) {
    return buildResult([], trimmed, offset, limit);
  }

  const tSearchStart = Date.now();
  const requestId = opts.requestId != null ? String(opts.requestId) : undefined;
  const scopeLabel = resolvedSearchScope(opts);

  return await runSearchTransaction(async (client) => {
    let queryMsAccum = 0;
    const timedQuery = async (sql: string, params: any[]) => {
      const t = Date.now();
      const result = await client.query(sql, params);
      queryMsAccum += Date.now() - t;
      return result;
    };
    const tsqueryMetaRes = await timedQuery(
      `SELECT websearch_to_tsquery('english', $1)::text AS tsquery_text,
              numnode(websearch_to_tsquery('english', $1)) AS tsquery_nodes`,
      [trimmed],
    );
    const tsqueryText = String(tsqueryMetaRes.rows[0]?.tsquery_text ?? '');
    const tsqueryNodes = Number(tsqueryMetaRes.rows[0]?.tsquery_nodes || 0);
    const strictTerms = tokenizeStrictSearchTerms(trimmed);
    const strictMultiWord = strictTerms.length > 1;
    const weakTsquery = strictMultiWord && tsqueryNodes <= 1;

    const ftsMeta = buildFtsParts(trimmed, opts);
    const ftsRes = await timedQuery(ftsMeta.sql, ftsMeta.params);
    throwIfScopeDenied(ftsRes.rows);

    const ftsHits = ftsRes.rows.filter((row: any) => row && row.id);
    const strictFtsHits = strictMultiWord
      ? ftsHits.filter((row: any) => messageMatchesAllStrictTerms(row?.content, strictTerms))
      : ftsHits;
    const ftsHitCount = ftsHits.length;
    const strictFtsHitCount = strictFtsHits.length;
    const communityFtsCandidateCount =
      scopeLabel === 'community'
        ? ftsRes.rows.find((r: any) => r && r.fts_candidate_count != null)?.fts_candidate_count
        : undefined;

    if (strictFtsHitCount > 0 && !weakTsquery) {
      const totalMs = Date.now() - tSearchStart;
      const basePayload = buildBaseSearchTracePayload({
        requestId,
        query: trimmed,
        scopeLabel,
        tsqueryText,
        tsqueryNodes,
        ftsHitCount,
        strictTermCount: strictTerms.length,
        strictFtsHitCount,
        queryMs: queryMsAccum,
        totalMs,
      });
      logSearchTrace({
        ...basePayload,
        fallback_used: false,
        fallback_hit_count: 0,
        fts_deep_used: false,
        ...buildCommunityTraceFields(
          scopeLabel,
          communityFtsCandidateCount,
          strictFtsHitCount,
        ),
      });
      return buildResult(strictFtsHits, ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
    }

    let deepFtsUsed = false;
    let deepFtsHitCount = 0;
    let deepStrictFtsHitCount = 0;
    let deepCommunityFtsCandidateCount: number | undefined;
    let effectiveStrictFtsHits = strictFtsHits;

    if (strictFtsHitCount === 0 && !weakTsquery) {
      const deepFtsMeta = buildFtsParts(trimmed, opts, ftsRecentCandidateCapDeep());
      const deepFtsRes = await timedQuery(deepFtsMeta.sql, deepFtsMeta.params);
      throwIfScopeDenied(deepFtsRes.rows);
      const deepFtsHits = deepFtsRes.rows.filter((row: any) => row && row.id);
      const deepStrictHits = strictMultiWord
        ? deepFtsHits.filter((row: any) => messageMatchesAllStrictTerms(row?.content, strictTerms))
        : deepFtsHits;
      deepFtsHitCount = deepFtsHits.length;
      deepStrictFtsHitCount = deepStrictHits.length;
      deepCommunityFtsCandidateCount =
        scopeLabel === 'community'
          ? deepFtsRes.rows.find((r: any) => r && r.fts_candidate_count != null)?.fts_candidate_count
          : undefined;
      deepFtsUsed = true;

      if (deepStrictHits.length > 0) {
        effectiveStrictFtsHits = deepStrictHits;
      }
    }

    if (effectiveStrictFtsHits.length > 0 && !weakTsquery) {
      const totalMs = Date.now() - tSearchStart;
      const basePayload = buildBaseSearchTracePayload({
        requestId,
        query: trimmed,
        scopeLabel,
        tsqueryText,
        tsqueryNodes,
        ftsHitCount,
        strictTermCount: strictTerms.length,
        strictFtsHitCount: effectiveStrictFtsHits.length,
        queryMs: queryMsAccum,
        totalMs,
      });
      logSearchTrace({
        ...basePayload,
        fallback_used: false,
        fallback_hit_count: 0,
        fts_deep_used: deepFtsUsed,
        deep_fts_hit_count: deepFtsHitCount,
        deep_strict_fts_hit_count: deepStrictFtsHitCount,
        ...buildCommunityTraceFields(
          scopeLabel,
          deepFtsUsed ? deepCommunityFtsCandidateCount : communityFtsCandidateCount,
          effectiveStrictFtsHits.length,
        ),
      });
      return buildResult(effectiveStrictFtsHits, ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
    }

    const literalMeta = buildScopedLiteralParts(
      trimmed,
      opts,
      strictTerms,
      literalRecentCandidateCapDeep(),
    );
    const literalRes = await timedQuery(literalMeta.sql, literalMeta.params);
    throwIfScopeDenied(literalRes.rows);
    const fallbackHits = literalRes.rows.filter((row: any) => row && row.id);
    const combinedHits = weakTsquery || strictMultiWord
      ? mergeSearchRowsPreferLiteral(fallbackHits, effectiveStrictFtsHits, limit, offset)
      : fallbackHits;
    const totalMs = Date.now() - tSearchStart;
    const basePayload = buildBaseSearchTracePayload({
      requestId,
      query: trimmed,
      scopeLabel,
      tsqueryText,
      tsqueryNodes,
      ftsHitCount,
      strictTermCount: strictTerms.length,
      strictFtsHitCount,
      queryMs: queryMsAccum,
      totalMs,
    });
    logSearchTrace({
      ...basePayload,
      fallback_used: true,
      fallback_hit_count: fallbackHits.length,
      weak_tsquery: weakTsquery,
      fts_deep_used: deepFtsUsed,
      deep_fts_hit_count: deepFtsHitCount,
      deep_strict_fts_hit_count: deepStrictFtsHitCount,
      ...buildCommunityTraceFields(
        scopeLabel,
        deepFtsUsed ? deepCommunityFtsCandidateCount : communityFtsCandidateCount,
        combinedHits.length,
      ),
    });
    return buildResult(combinedHits, literalMeta.q, literalMeta.offset, literalMeta.limit);
  }, { forcePrimary });
}

// ── Meili-backed search path ──────────────────────────────────────────────────

const { searchWithMeiliBackend } = createMeiliSearchExecutor({
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
  searchUseReadReplica: SEARCH_USE_READ_REPLICA,
  searchOnce,
});

async function search(q: string, opts: Record<string, any> = {}): Promise<any> {
  const trimmed = String(q || '').trim();

  // Meili path: attempt Meili-backed candidate generation with Postgres recheck.
  // Falls back to Postgres on any Meili error.
  if (meiliClient.isSearchBackend()) {
    try {
      return await searchWithMeiliBackend(trimmed, opts);
    } catch (err: any) {
      if (err?.meiliUnavailable) {
        // Already logged; fall through to Postgres search below.
      } else if (err?.statusCode === 403) {
        throw err;
      } else {
        meiliClient.incFallbackTotal();
        logger.warn(
          { err: { message: err?.message }, query: trimmed },
          'search: meili recheck error, falling back to postgres',
        );
      }
    }
  }

  // Postgres path (default and fallback).
  const initialForcePrimary = !SEARCH_USE_READ_REPLICA;

  try {
    const result = await searchOnce(trimmed, opts, initialForcePrimary);
    if (!shouldRetrySearchOnPrimary(initialForcePrimary, result)) {
      return result;
    }
    logPrimaryRetry(
      trimmed,
      opts,
      'search: replica returned empty result set, retrying on primary',
    );
    return await searchOnce(trimmed, opts, true);
  } catch (err) {
    if (!shouldRetrySearchOnPrimary(initialForcePrimary, null, err)) {
      throw err;
    }
    logPrimaryRetry(
      trimmed,
      opts,
      'search: replica access check may be stale, retrying on primary',
    );
    return searchOnce(trimmed, opts, true);
  }
}

module.exports =
  process.env.NODE_ENV === 'test'
    ? {
        search,
        __testBuildScopedLiteralParts: buildScopedLiteralParts,
        __testFindFreshScopedSearchCandidateIds: findFreshScopedSearchCandidateIds,
      }
    : { search };
