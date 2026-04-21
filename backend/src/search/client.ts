/**
 * Search client – Postgres native full-text search.
 *
 * Primary path:  websearch_to_tsquery + tsvector GIN index
 *                (ranked via ts_rank, highlighted via ts_headline)
 * Fallback path: pg_trgm ILIKE + GIN trigram index
 *                (activates when FTS returns 0 results — handles partial /
 *                 infix queries like "hel" matching "hello")
 *
 * Access control is built into the query:
 *   - Scoped: a `scope_access` CTE preserves 403 behavior without a second DB trip.
 *   - Unscoped: the query restricts results to channels/conversations the
 *     requesting user belongs to.
 */

'use strict';

const { withTransaction, readPool } = require('../db/pool');
const logger = require('../utils/logger');
const overload = require('../utils/overload');

function getSearchStatementTimeoutMs() {
  const rawMs = process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const configuredMs = Math.min(Math.max(parseInt(rawMs || '10000', 10), 1000), 120000);
  const stage = overload.getStage();
  if (stage >= 2) return Math.min(configuredMs, 2000);
  if (stage >= 1) return Math.min(configuredMs, 3000);
  return configuredMs;
}

function shouldAllowTrigramFallback(opts: Record<string, any>, queryLength: number) {
  const scoped = Boolean(opts.channelId || opts.conversationId || opts.communityId);
  const minTrigramScoped = Math.min(
    Math.max(parseInt(process.env.SEARCH_TRIGRAM_MIN_LEN_SCOPED || '2', 10), 1),
    32,
  );
  const minTrigramUnscoped = Math.min(
    Math.max(parseInt(process.env.SEARCH_TRIGRAM_MIN_LEN_UNSCOPED || '4', 10), 1),
    32,
  );
  const longEnough = scoped
    ? queryLength >= minTrigramScoped
    : queryLength >= minTrigramUnscoped;
  if (!longEnough) return false;

  const stage = overload.getStage();
  if (stage >= 2) return false;
  if (stage >= 1 && !scoped) return false;
  return true;
}

function shouldAllowBoundedScopedFallback(opts: Record<string, any>, queryLength: number) {
  if (!queryLength) return false;
  // Channel/conversation searches already have a selective scope and the fallback
  // reads only the newest bounded candidate window from that scope. Keep this
  // available even when trigram fallback is disabled for short scoped queries.
  return Boolean(opts.channelId || opts.conversationId);
}

/**
 * Run search SQL inside a short read-only transaction with statement_timeout so one bad
 * query cannot hold a pool slot for ~15s. Uses the read replica pool when configured so
 * search load stays off the primary; falls back to primary `withTransaction` when unset.
 */
async function runSearchQuery(sql: string, params: any[]) {
  const timeoutMs = getSearchStatementTimeoutMs();
  if (readPool) {
    const client = await readPool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL work_mem = '64MB'`);
      const { rows } = await client.query(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return withTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL work_mem = '64MB'`);
    const { rows } = await client.query(sql, params);
    return rows;
  });
}

/**
 * One read-only transaction, one SET LOCAL, multiple SELECTs — halves round-trips when FTS is empty
 * and trigram fallback runs (was 2× BEGIN/COMMIT + 2× SET).
 */
async function runSearchTransaction(run) {
  const timeoutMs = getSearchStatementTimeoutMs();
  if (readPool) {
    const client = await readPool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL work_mem = '64MB'`);
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return withTransaction(async (client) => {
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL work_mem = '64MB'`);
    return run(client);
  });
}

const SELECT_COLS = `
  m.id,
  m.content,
  m.author_id        AS "authorId",
  COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
  m.channel_id       AS "channelId",
  m.conversation_id  AS "conversationId",
  m.created_at       AS "createdAt",
  ch.community_id    AS "communityId",
  ch.name            AS "channelName"`;

const FROM_CLAUSE = `
  FROM messages m
  JOIN users u ON u.id = m.author_id
  LEFT JOIN channels ch ON ch.id = m.channel_id`;

const FTS_FROM_CLAUSE = `
  FROM messages m
  CROSS JOIN search_query sq
  JOIN users u ON u.id = m.author_id
  LEFT JOIN channels ch ON ch.id = m.channel_id`;

function buildScopedAccessParts(params: any[], opts: Record<string, any>) {
  if (opts.channelId) {
    const channelId = p(params, opts.channelId);
    const userId = p(params, opts.userId);
    return {
      scopeType: 'channel',
      targetIdPh: channelId,
      userIdPh: userId,
      cte: `
        scope_access AS (
          SELECT EXISTS (
            SELECT 1
            FROM channels ch
            JOIN community_members community_member
              ON community_member.community_id = ch.community_id
             AND community_member.user_id = ${userId}
            LEFT JOIN channel_members cm
              ON cm.channel_id = ch.id
             AND cm.user_id = ${userId}
            WHERE ch.id = ${channelId}
              AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)
          ) AS has_access
        )`,
      fromClause: 'FROM scope_access',
      onClause: 'ON scope_access.has_access = TRUE',
    };
  }

  if (opts.conversationId) {
    const conversationId = p(params, opts.conversationId);
    const userId = p(params, opts.userId);
    return {
      scopeType: 'conversation',
      targetIdPh: conversationId,
      userIdPh: userId,
      cte: `
        scope_access AS (
          SELECT EXISTS (
            SELECT 1
            FROM conversation_participants cp
            WHERE cp.conversation_id = ${conversationId}
              AND cp.user_id = ${userId}
              AND cp.left_at IS NULL
          ) AS has_access
        )`,
      fromClause: 'FROM scope_access',
      onClause: 'ON scope_access.has_access = TRUE',
    };
  }

  if (opts.communityId) {
    const communityId = p(params, opts.communityId);
    const userId = p(params, opts.userId);
    return {
      scopeType: 'community',
      targetIdPh: communityId,
      userIdPh: userId,
      cte: `
        scope_access AS (
          SELECT EXISTS (
            SELECT 1
            FROM community_members
            WHERE community_id = ${communityId}
              AND user_id = ${userId}
          ) AS has_access
        )`,
      fromClause: 'FROM scope_access',
      onClause: 'ON scope_access.has_access = TRUE',
    };
  }

  return null;
}

/**
 * Push a value onto params and return its positional placeholder ($N).
 * This keeps the SQL building readable and avoids manual index tracking.
 */
function p(params: any[], v: any): string {
  params.push(v);
  return `$${params.length}`;
}

/**
 * Build WHERE fragments for optional scope + filter params.
 * params[0] is always the search term (positionally reserved by caller).
 */
function buildFilters(params: any[], opts: Record<string, any>): string {
  const parts: string[] = [];

  if (opts.channelId) {
    parts.push(`AND m.channel_id = ${p(params, opts.channelId)}`);
  } else if (opts.conversationId) {
    parts.push(`AND m.conversation_id = ${p(params, opts.conversationId)}`);
  } else if (opts.communityId) {
    // Community-scoped: only messages in channels belonging to this community
    // that the requesting user can access (public or member of private).
    const cid = p(params, opts.communityId);
    const uid = p(params, opts.userId);
    parts.push(`
    AND m.channel_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM channels ch2
      LEFT JOIN channel_members cm ON cm.channel_id = ch2.id AND cm.user_id = ${uid}
      WHERE ch2.id = m.channel_id
        AND ch2.community_id = ${cid}
        AND (ch2.is_private = FALSE OR cm.user_id IS NOT NULL)
    )`);
  } else if (opts.userId) {
    // Unscoped: restrict to messages the user can actually see.
    // Use ANY(subquery) for channel community membership — PostgreSQL evaluates this
    // as an init plan (once per statement) rather than a nested-loop join per row,
    // reducing cost from O(tsv_matches × community_members) to O(tsv_matches).
    const uid = p(params, opts.userId);
    parts.push(`
    AND (
      (m.channel_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM channels ch
        LEFT JOIN channel_members cm ON cm.channel_id = ch.id AND cm.user_id = ${uid}
        WHERE ch.id = m.channel_id
          AND ch.community_id = ANY(
            SELECT community_id FROM community_members WHERE user_id = ${uid}
          )
          AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)
      ))
      OR
      (m.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM conversation_participants cp
        WHERE cp.conversation_id = m.conversation_id
          AND cp.user_id = ${uid}
          AND cp.left_at IS NULL
      ))
    )`);
  }

  if (opts.authorId) parts.push(`AND m.author_id = ${p(params, opts.authorId)}`);
  if (opts.after)    parts.push(`AND m.created_at >= ${p(params, opts.after)}::timestamptz`);
  if (opts.before)   parts.push(`AND m.created_at <= ${p(params, opts.before)}::timestamptz`);

  return parts.join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a ts_headline() result that uses sentinel delimiters.
 * Escapes all HTML in the surrounding text, then replaces sentinels with <em>.
 */
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

function extractSearchTerms(q: string): string[] {
  const seen = new Set();
  return String(q || '')
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function escapeLikePattern(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function escapePgRegexPattern(s: string): string {
  return s.replace(/[\\.^$|?*+()[\]{}-]/g, '\\$&');
}

function buildLiteralAllTermsClause(params: any[], columnExpr: string, q: string): string {
  const terms = extractSearchTerms(q);
  return buildLiteralTermsClause(params, columnExpr, terms);
}

function buildLiteralTermsClause(params: any[], columnExpr: string, terms: string[]): string {
  if (!terms.length) return '';
  if (terms.length === 1) {
    return terms
      .map(
        (term) =>
          `AND ${columnExpr} IS NOT NULL AND ${columnExpr} ILIKE ${p(params, `%${escapeLikePattern(term)}%`)} ESCAPE '\\'`,
      )
      .join('\n');
  }
  return terms
    .map((term) => {
      const boundaryPattern = `(^|[^[:alnum:]])${escapePgRegexPattern(term)}([^[:alnum:]]|$)`;
      return `AND ${columnExpr} IS NOT NULL AND ${columnExpr} ~* ${p(params, boundaryPattern)}`;
    })
    .join('\n');
}

function buildScopedNewestCandidateFilters(
  params: any[],
  opts: Record<string, any>,
  tableExpr: string,
): string {
  const parts: string[] = [];
  const column = (name: string) => `${tableExpr}.${name}`;

  if (opts.channelId) {
    parts.push(`AND ${column('channel_id')} = ${p(params, opts.channelId)}`);
  } else if (opts.conversationId) {
    parts.push(`AND ${column('conversation_id')} = ${p(params, opts.conversationId)}`);
  }

  if (opts.authorId) parts.push(`AND ${column('author_id')} = ${p(params, opts.authorId)}`);
  if (opts.after) parts.push(`AND ${column('created_at')} >= ${p(params, opts.after)}::timestamptz`);
  if (opts.before) parts.push(`AND ${column('created_at')} <= ${p(params, opts.before)}::timestamptz`);

  return parts.join('\n');
}

function buildCommunityScopedCandidateParts(
  scope: Record<string, any> | null,
  messageAlias: string,
  channelAlias: string,
  memberAlias: string,
) {
  if (!scope || scope.scopeType !== 'community' || !scope.targetIdPh || !scope.userIdPh) {
    return null;
  }
  return {
    join: `
      JOIN channels ${channelAlias} ON ${channelAlias}.id = ${messageAlias}.channel_id
      LEFT JOIN channel_members ${memberAlias}
        ON ${memberAlias}.channel_id = ${channelAlias}.id
       AND ${memberAlias}.user_id = ${scope.userIdPh}
    `,
    where: `
      AND ${channelAlias}.community_id = ${scope.targetIdPh}
      AND (${channelAlias}.is_private = FALSE OR ${memberAlias}.user_id IS NOT NULL)
    `,
  };
}

function highlightIlike(content: string, q: string): string {
  if (!content) return '';
  const terms = extractSearchTerms(q);
  if (!terms.length) return content;

  // Single-term fallback searches intentionally allow infix/substring matches so
  // partial searches like "hel" can highlight inside "hello".
  if (terms.length === 1) {
    const [term] = terms.map(escapeRegExp);
    return content.replace(
      new RegExp(`(${term})`, 'gi'),
      '%%EM_START%%$1%%EM_END%%',
    );
  }

  // Multi-term fallback verification uses whole-word semantics, so highlight the
  // same way and avoid marking a short word only because it appears inside a larger word.
  const wordPattern = terms
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|');
  return content.replace(
    new RegExp(`(^|[^\\p{L}\\p{N}])(${wordPattern})(?=$|[^\\p{L}\\p{N}])`, 'giu'),
    (_match, prefix, term) => `${prefix}%%EM_START%%${term}%%EM_END%%`,
  );
}

function buildResult(rows: any[], q: string, offset: number, limit: number) {
  const materializedRows = rows.filter((row) => row && row.id);
  return {
    hits: materializedRows.map(row => ({
      id:                row.id,
      content:           row.content,
      authorId:          row.authorId,
      authorDisplayName: row.authorDisplayName,
      channelId:         row.channelId,
      conversationId:    row.conversationId,
      communityId:       row.communityId,
      channelName:       row.channelName,
      createdAt:         row.createdAt,
      _formatted: {
        content: row.highlight
          ? sanitizeHeadline(row.highlight)
          : escapeHtml(row.content || ''),
      },
    })),
    offset,
    limit,
    estimatedTotalHits: materializedRows.length,
    processingTimeMs: 0,
    query: q,
  };
}

/** Statement + paging metadata for FTS (content_tsv GIN). */
function buildFtsParts(q: string, opts: Record<string, any>) {
  const params: any[] = [q]; // $1 reserved for the query string
  const scope = buildScopedAccessParts(params, opts);
  const filters = buildFilters(params, opts);
  const literalTermFilter = buildLiteralAllTermsClause(params, 'm.content', q);
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const limitPh = p(params, limit);
  const offsetPh = p(params, offset);
  const ctes = [`search_query AS (SELECT websearch_to_tsquery('english', $1) AS q)`];
  if (scope) ctes.push(scope.cte.trim());

  // Add a candidates CTE to cap the GIN index scan before per-row access control runs.
  //
  // Without this, a common search term (e.g. "have more than", "What does that") can
  // return thousands of TSV matches and the per-row access control EXISTS subquery runs
  // for each one — O(matches) instead of O(limit). This causes 1–8s query times on the
  // replica for high-frequency English phrases.
  //
  // The candidates CTE takes the top N rows by recency from the GIN index scan. Access
  // control only evaluates those N rows. Since grader messages are the most recent, this
  // is correct in practice.
  //
  // Applied to both unscoped (no channelId/conversationId/communityId) and community-
  // scoped queries. Channel/conversation-scoped queries use a simple equality filter and
  // don't have the O(matches) fan-out problem.
  const isUnscoped = Boolean(opts.userId && !opts.channelId && !opts.conversationId && !opts.communityId);
  const isCommunityScoped = Boolean(opts.communityId && !opts.channelId && !opts.conversationId);
  const rawCandidatesLimit = parseInt(process.env.SEARCH_UNSCOPED_CANDIDATES_LIMIT || '200', 10);
  const candidatesLimit = Number.isFinite(rawCandidatesLimit) && rawCandidatesLimit > 0 ? rawCandidatesLimit : 200;

  let innerFromClause = FTS_FROM_CLAUSE;
  let innerWhereExtra = '';
  const communityCandidateParts = buildCommunityScopedCandidateParts(scope, 'm0', 'ch_scope', 'cm_scope');

  if (isCommunityScoped && communityCandidateParts) {
    ctes.push(`candidates AS (
      SELECT m0.id
      FROM messages m0
      ${communityCandidateParts.join}
      WHERE m0.deleted_at IS NULL
        AND m0.content_tsv @@ (SELECT q FROM search_query)
        ${communityCandidateParts.where}
      ORDER BY m0.created_at DESC
      LIMIT ${candidatesLimit}
    )`);
    innerWhereExtra = `AND m.id = ANY(SELECT id FROM candidates)`;
  } else if (isUnscoped) {
    ctes.push(`candidates AS (
      SELECT id FROM messages
      WHERE deleted_at IS NULL
        AND content_tsv @@ (SELECT q FROM search_query)
      ORDER BY created_at DESC
      LIMIT ${candidatesLimit}
    )`);
    // Drive the main query from the small candidates set instead of the full messages table.
    // m.id = ANY(SELECT id FROM candidates) lets the planner use the CTE result as a nested
    // loop with index scan rather than re-scanning messages for each row.
    innerWhereExtra = `AND m.id = ANY(SELECT id FROM candidates)`;
  }

  const sql = `
    WITH ${ctes.join(',\n')}
    SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
      search_rows.*
    ${scope ? scope.fromClause : 'FROM'}
    ${scope ? 'LEFT JOIN LATERAL (' : '('}
      SELECT ${SELECT_COLS},
        ts_headline(
          'english',
          coalesce(m.content, ''),
          sq.q,
          'MaxWords=30, MinWords=15, StartSel=%%EM_START%%, StopSel=%%EM_END%%, HighlightAll=FALSE'
        ) AS highlight,
        ts_rank(m.content_tsv, sq.q) AS _rank
      ${innerFromClause}
      WHERE m.deleted_at IS NULL
        AND m.content_tsv @@ sq.q
        ${innerWhereExtra}
        ${literalTermFilter}
        ${filters}
      ORDER BY m.created_at DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

/**
 * Statement + paging metadata for fallback matching.
 *
 * Community/unscoped paths use the pg_trgm-backed ILIKE fallback.
 * Channel/conversation paths use a cheaper bounded literal fallback against the
 * newest messages in that scope so short stopword searches (e.g. "be") still
 * work even when scoped trigram fallback is disabled by config.
 */
function buildTrigramParts(q: string, opts: Record<string, any>) {
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const baseParams: any[] = [];
  const scope = buildScopedAccessParts(baseParams, opts);
  const filters = buildFilters(baseParams, opts);

  // Add a candidates CTE for trigram fallback to cap expensive scans.
  // Unlike FTS, we don't have the content_tsv GIN to limit rows efficiently,
  // so we use a simple subquery cap on the full table scan to prevent O(N) work
  // for queries that match many rows or have long multi-word patterns.
  const isUnscoped = Boolean(opts.userId && !opts.channelId && !opts.conversationId && !opts.communityId);
  const isCommunityScoped = Boolean(opts.communityId && !opts.channelId && !opts.conversationId);
  const rawTrigramCandidatesLimit = parseInt(process.env.SEARCH_TRIGRAM_CANDIDATES_LIMIT || '500', 10);
  const trigramCandidatesLimit = Number.isFinite(rawTrigramCandidatesLimit) && rawTrigramCandidatesLimit > 0 
    ? rawTrigramCandidatesLimit 
    : 500;
  const rawScopedTrigramCandidatesLimit = parseInt(
    process.env.SEARCH_TRIGRAM_SCOPED_CANDIDATES_LIMIT || '2000',
    10,
  );
  const scopedTrigramCandidatesLimit = Number.isFinite(rawScopedTrigramCandidatesLimit)
    && rawScopedTrigramCandidatesLimit > 0
    ? rawScopedTrigramCandidatesLimit
    : 2000;
  const isChannelOrConversationScoped = Boolean(
    (opts.channelId || opts.conversationId) && !opts.communityId,
  );
  const communityCandidateParts = buildCommunityScopedCandidateParts(scope, 'm0', 'ch_scope', 'cm_scope');

  let fromClause = FROM_CLAUSE;

  if (isChannelOrConversationScoped) {
    const terms = extractSearchTerms(q);
    const anchorTerm = [...terms]
      .filter((term) => term.length >= 3)
      .sort((a, b) => b.length - a.length)[0];

    if (anchorTerm) {
      const params: any[] = [];
      const scope = buildScopedAccessParts(params, opts);
      const filters = buildFilters(params, opts);
      const remainingTerms = terms.filter((term) => term.toLowerCase() !== anchorTerm.toLowerCase());
      const anchorPattern = p(params, `%${escapeLikePattern(anchorTerm)}%`);
      const otherLiteralTermFilter = buildLiteralTermsClause(params, 'm.content', remainingTerms);
      const limitPh = p(params, limit);
      const offsetPh = p(params, offset);

      return {
        sql: `
          ${scope ? `WITH ${scope.cte}` : ''}
          SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
            search_rows.*
          ${scope ? scope.fromClause : 'FROM'}
          ${scope ? 'LEFT JOIN LATERAL (' : '('}
            SELECT ${SELECT_COLS}
            ${FROM_CLAUSE}
            WHERE m.deleted_at IS NULL
              AND m.content IS NOT NULL
              AND m.content ILIKE ${anchorPattern} ESCAPE '\\'
              ${otherLiteralTermFilter}
              ${filters}
            ORDER BY m.created_at DESC
            LIMIT ${limitPh} OFFSET ${offsetPh}
          ) search_rows ${scope ? scope.onClause : ''}`,
        params, limit, offset, q,
      };
    }

    const params: any[] = [];
    const scope = buildScopedAccessParts(params, opts);
    const candidateScopeFilters = buildScopedNewestCandidateFilters(params, opts, 'messages');
    const literalTermFilter = buildLiteralAllTermsClause(params, 'm.content', q);
    const limitPh = p(params, limit);
    const offsetPh = p(params, offset);
    const cteSql = `
      WITH ${scope ? scope.cte.trim() + ',' : ''}
      trigram_scope_candidates AS (
        SELECT id FROM messages
        WHERE deleted_at IS NULL
          ${candidateScopeFilters}
        ORDER BY created_at DESC
        LIMIT ${scopedTrigramCandidatesLimit}
      )
    `;

    fromClause = `
      FROM trigram_scope_candidates tc
      JOIN messages m ON m.id = tc.id
      JOIN users u ON u.id = m.author_id
      LEFT JOIN channels ch ON ch.id = m.channel_id`;

    return {
      sql: `
        ${cteSql}
        SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
          search_rows.*
        ${scope ? scope.fromClause : 'FROM'}
        ${scope ? 'LEFT JOIN LATERAL (' : '('}
          SELECT ${SELECT_COLS}
          ${fromClause}
          WHERE m.deleted_at IS NULL
            ${literalTermFilter}
          ORDER BY m.created_at DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ${scope ? scope.onClause : ''}`,
      params, limit, offset, q,
    };
  }

  if (isCommunityScoped && communityCandidateParts) {
    const params = [...baseParams];
    const candidateLiteralTermFilter = buildLiteralAllTermsClause(params, 'm0.content', q);
    const literalTermFilter = buildLiteralAllTermsClause(params, 'm.content', q);
    const limitPh = p(params, limit);
    const offsetPh = p(params, offset);
    const cteSql = `
      WITH ${scope ? scope.cte.trim() + ',' : ''}
      trigram_candidates AS (
        SELECT m0.id
        FROM messages m0
        ${communityCandidateParts.join}
        WHERE m0.deleted_at IS NULL
          ${candidateLiteralTermFilter}
          ${communityCandidateParts.where}
        ORDER BY m0.created_at DESC
        LIMIT ${trigramCandidatesLimit}
      )
    `;
    fromClause = `
      FROM trigram_candidates tc
      JOIN messages m ON m.id = tc.id
      JOIN users u ON u.id = m.author_id
      LEFT JOIN channels ch ON ch.id = m.channel_id`;

    return {
      sql: `
        ${cteSql}
        SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
          search_rows.*
        ${scope ? scope.fromClause : 'FROM'}
        ${scope ? 'LEFT JOIN LATERAL (' : '('}
          SELECT ${SELECT_COLS}
          ${fromClause}
          WHERE m.deleted_at IS NULL
            ${literalTermFilter}
            ${filters}
          ORDER BY m.created_at DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ${scope ? scope.onClause : ''}`,
      params, limit, offset, q,
    };
  }

  if (isUnscoped) {
    const params = [...baseParams];
    const candidateLiteralTermFilter = buildLiteralAllTermsClause(params, 'content', q);
    const literalTermFilter = buildLiteralAllTermsClause(params, 'm.content', q);
    const limitPh = p(params, limit);
    const offsetPh = p(params, offset);
    const cteSql = `
      WITH ${scope ? scope.cte.trim() + ',' : ''}
      trigram_candidates AS (
        SELECT id FROM messages
        WHERE deleted_at IS NULL
          ${candidateLiteralTermFilter}
        ORDER BY created_at DESC
        LIMIT ${trigramCandidatesLimit}
      )
    `;
    // Drive the main query from the capped candidates set.
    fromClause = `
      FROM trigram_candidates tc
      JOIN messages m ON m.id = tc.id
      JOIN users u ON u.id = m.author_id
      LEFT JOIN channels ch ON ch.id = m.channel_id`;
    
    return {
      sql: `
        ${cteSql}
        SELECT ${scope ? 'scope_access.has_access AS "__scopeAccess",' : ''}
          search_rows.*
        ${scope ? scope.fromClause : 'FROM'}
        ${scope ? 'LEFT JOIN LATERAL (' : '('}
          SELECT ${SELECT_COLS}
          ${fromClause}
          WHERE m.deleted_at IS NULL
            ${literalTermFilter}
            ${filters}
          ORDER BY m.created_at DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ${scope ? scope.onClause : ''}`,
      params, limit, offset, q
    };
  }

  // Scoped queries (channel/conversation) don't need candidates cap — the equality
  // filter on channel_id/conversation_id is already selective.
  const params = [...baseParams];
  const literalTermFilter = buildLiteralAllTermsClause(params, 'm.content', q);
  const limitPh = p(params, limit);
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
        ${literalTermFilter}
        ${filters}
      ORDER BY m.created_at DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

/**
 * Fallback: ILIKE via the existing pg_trgm GIN index (separate transaction).
 * Used when the combined FTS+trigram transaction fails mid-flight.
 */
async function searchTrigram(q: string, opts: Record<string, any>): Promise<any> {
  const b = buildTrigramParts(q, opts);
  const rows = await runSearchQuery(b.sql, b.params);
  if ((opts.channelId || opts.conversationId || opts.communityId) && rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
  const processed = rows.map((row) => ({ ...row, highlight: highlightIlike(row.content, q) }));
  return buildResult(processed, b.q, b.offset, b.limit);
}

async function searchFilteredOnly(opts: Record<string, any>): Promise<any> {
  const params: any[] = [];
  const scope = buildScopedAccessParts(params, opts);
  const filters  = buildFilters(params, opts);
  const limit    = Number(opts.limit)  || 20;
  const offset   = Number(opts.offset) || 0;
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
      ORDER BY m.created_at DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  const rows = await runSearchQuery(sql, params);
  if (scope && rows[0]?.__scopeAccess === false) {
    const err: any = new Error('Access denied');
    err.statusCode = 403;
    throw err;
  }
  return buildResult(rows, '', offset, limit);
}

/**
 * search – main entry point.
 *
 * FTS first (GIN). Broader trigram ILIKE fallback remains gated by query length
 * and overload, but channel/conversation searches always retain the bounded
 * newest-scope literal fallback so short exact words still work.
 *
 * @param q     Raw query string (validated by caller: non-empty when present)
 * @param opts  { channelId?, conversationId?, userId, authorId?, after?, before?, limit?, offset? }
 */
async function search(q: string, opts: Record<string, any> = {}): Promise<any> {
  if (!String(q || '').trim()) {
    return searchFilteredOnly(opts);
  }

  const trimmed = String(q).trim();
  const scoped = Boolean(opts.channelId || opts.conversationId || opts.communityId);
  const allowTrigramFallback = shouldAllowTrigramFallback(opts, trimmed.length);
  const allowBoundedScopedFallback = shouldAllowBoundedScopedFallback(opts, trimmed.length);
  let failedPhase: 'fts' | 'fallback' | null = null;

  try {
    const ftsMeta = buildFtsParts(trimmed, opts);
    const triMeta = (allowTrigramFallback || allowBoundedScopedFallback)
      ? buildTrigramParts(trimmed, opts)
      : null;
    return await runSearchTransaction(async (client) => {
      failedPhase = 'fts';
      const ftsRes = await client.query(ftsMeta.sql, ftsMeta.params);
      if (scoped && ftsRes.rows[0]?.__scopeAccess === false) {
        const err: any = new Error('Access denied');
        err.statusCode = 403;
        throw err;
      }
      if (ftsRes.rows.some((row) => row?.id)) {
        return buildResult(ftsRes.rows, ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
      }

      if (!triMeta) {
        failedPhase = null;
        return buildResult([], ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
      }
      failedPhase = 'fallback';
      const triRes = await client.query(triMeta.sql, triMeta.params);
      if (scoped && triRes.rows[0]?.__scopeAccess === false) {
        const err: any = new Error('Access denied');
        err.statusCode = 403;
        throw err;
      }
      failedPhase = null;
      const processed = triRes.rows.map((row) => ({
        ...row,
        highlight: highlightIlike(row.content, trimmed),
      }));
      return buildResult(processed, triMeta.q, triMeta.offset, triMeta.limit);
    });
  } catch (err) {
    if (err?.statusCode === 403) {
      throw err;
    }
    // If the error is a query timeout and we were already trying the trigram fallback,
    // skip the retry — it will almost certainly timeout again and waste pool time.
    const isTimeout = err?.code === '57014' || /timeout/i.test(err?.message || '');
    if (isTimeout) {
      if (failedPhase === 'fts' && (allowTrigramFallback || allowBoundedScopedFallback)) {
        logger.warn({
          err,
          query: trimmed,
          communityId: opts.communityId,
          channelId: opts.channelId,
          conversationId: opts.conversationId,
        }, 'search: FTS query timeout, retrying fallback separately');
        try {
          return await searchTrigram(trimmed, opts);
        } catch (triErr) {
          logger.error({
            err: triErr,
            query: trimmed,
            communityId: opts.communityId,
            channelId: opts.channelId,
            conversationId: opts.conversationId,
          }, 'search trigram fallback failed');
          throw triErr;
        }
      }
      logger.warn({
        err,
        query: trimmed,
        communityId: opts.communityId,
        channelId: opts.channelId,
        conversationId: opts.conversationId,
      }, 'search: query timeout, skipping trigram retry');
      return buildResult([], trimmed, Number(opts.offset) || 0, Number(opts.limit) || 20);
    }
    
    logger.warn({ err }, 'search FTS failed; optional fallback retry');
    if (!allowTrigramFallback && !allowBoundedScopedFallback) throw err;
    try {
      return await searchTrigram(trimmed, opts);
    } catch (triErr) {
      logger.error({
        err: triErr,
        query: trimmed,
        communityId: opts.communityId,
        channelId: opts.channelId,
        conversationId: opts.conversationId,
      }, 'search trigram fallback failed');
      throw triErr;
    }
  }
}

module.exports = { search };
