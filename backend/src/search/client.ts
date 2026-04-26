/**
 * Search client – Postgres native full-text search (FTS primary).
 *
 * Primary path:  websearch_to_tsquery + tsvector GIN index
 *                (ranked via ts_rank, highlighted via ts_headline)
 *
 * Scoped searches only (community, channel, or conversation). If FTS returns no
 * rows, a bounded literal substring pass runs inside the same scope (no trigram,
 * no cross-scope scan). There is no global / membership-only search path.
 *
 * Access control is built into the query:
 *   - `scope_access` CTE preserves 403 without a second DB trip.
 *   - FTS candidate generation applies the same access rules as `scope_access`
 *     before ORDER BY / LIMIT on hot paths (community channels, channel privacy,
 *     conversation participation).
 */

'use strict';

const db = require('../db/pool');
const { getClientTimed } = db;
const logger = require('../utils/logger');
const overload = require('../utils/overload');
const meiliClient = require('./meiliClient');

const SEARCH_USE_READ_REPLICA =
  String(process.env.SEARCH_USE_READ_REPLICA || '').trim().toLowerCase() === 'true';
/**
 * Max recent messages scanned per scope before applying literal substring
 * (community: per channel). Evaluated per query (not at module load).
 * Default 200, clamped 10..1000 so tests can lower the cap.
 */
function literalRecentCandidateCap(): number {
  const raw = parseInt(
    process.env.STOPWORD_LITERAL_RECENT_CANDIDATES_LIMIT ||
      process.env.STOPWORD_LITERAL_RECENT_PER_CHANNEL_LIMIT ||
      '200',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 200;
  return Math.min(Math.max(v, 10), 1000);
}

/**
 * Community fallback only: cap how many channels we probe per query.
 * This bounds the LATERAL-per-channel work and avoids scanning long-tail
 * inactive channels on stopword literal fallback.
 */
function literalCommunityChannelCap(): number {
  const raw = parseInt(
    process.env.STOPWORD_LITERAL_COMMUNITY_CHANNELS_LIMIT || '8',
    10,
  );
  const v = Number.isFinite(raw) && raw > 0 ? raw : 8;
  return Math.min(Math.max(v, 1), 32);
}

function getSearchStatementTimeoutMs() {
  const rawMs = process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const configuredMs = Math.min(2000, Math.max(1500, parseInt(rawMs || '1750', 10) || 1750));
  const stage = overload.getStage();
  if (stage >= 2) return Math.min(configuredMs, 2000);
  if (stage >= 1) return Math.min(configuredMs, 2000);
  return configuredMs;
}

function logSearchDbTiming(
  kind: string,
  acquireMs: number,
  queryMs: number,
  totalMs: number,
  extra: Record<string, unknown> = {},
) {
  const payload = {
    search_db_timing: true,
    kind,
    acquire_ms: acquireMs,
    query_ms: queryMs,
    total_ms: totalMs,
    ...extra,
  };
  if (totalMs > 300 || acquireMs > 50) {
    logger.warn(payload, 'search_db_timing');
  } else {
    logger.debug(payload, 'search_db_timing');
  }
}

function resolvedSearchScope(opts: Record<string, any>): string {
  if (opts.communityId) return 'community';
  if (opts.channelId) return 'channel';
  if (opts.conversationId) return 'conversation';
  return 'none';
}

function isScopedSearch(opts: Record<string, any>): boolean {
  return Boolean(opts.communityId || opts.channelId || opts.conversationId);
}

function logSearchTrace(payload: Record<string, unknown>) {
  logger.info({ search_trace: true, ...payload }, 'search_trace');
}

async function runSearchQuery(
  sql: string,
  params: any[],
  options: { forcePrimary?: boolean } = {},
) {
  const timeoutMs = getSearchStatementTimeoutMs();
  const readPool = !options.forcePrimary && SEARCH_USE_READ_REPLICA ? db.readPool : null;
  const tAll = Date.now();
  if (readPool) {
    const tConn = Date.now();
    const client = await readPool.connect();
    const acquireMs = Date.now() - tConn;
    const tWork = Date.now();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL work_mem = '64MB'`);
      await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
      const { rows } = await client.query(sql, params);
      await client.query('COMMIT');
      const queryMs = Date.now() - tWork;
      const totalMs = Date.now() - tAll;
      logSearchDbTiming('search_query', acquireMs, queryMs, totalMs, {
        rowCount: rows.length,
        sqlLength: sql.length,
        paramCount: params.length,
      });
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const { client, acquireMs } = await getClientTimed();
  const tWork = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL work_mem = '64MB'`);
    await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
    const { rows } = await client.query(sql, params);
    await client.query('COMMIT');
    const queryMs = Date.now() - tWork;
    const totalMs = Date.now() - tAll;
    logSearchDbTiming('search_query', acquireMs, queryMs, totalMs, {
      rowCount: rows.length,
      sqlLength: sql.length,
      paramCount: params.length,
    });
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function runSearchTransaction(run, options: { forcePrimary?: boolean } = {}) {
  const timeoutMs = getSearchStatementTimeoutMs();
  const readPool = !options.forcePrimary && SEARCH_USE_READ_REPLICA ? db.readPool : null;
  const tAll = Date.now();
  if (readPool) {
    const tConn = Date.now();
    const client = await readPool.connect();
    const acquireMs = Date.now() - tConn;
    const tWork = Date.now();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      await client.query(`SET LOCAL work_mem = '64MB'`);
      await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
      const out = await run(client);
      await client.query('COMMIT');
      const queryMs = Date.now() - tWork;
      const totalMs = Date.now() - tAll;
      logSearchDbTiming('search_transaction', acquireMs, queryMs, totalMs, {});
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  const { client, acquireMs } = await getClientTimed();
  const tWork = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL work_mem = '64MB'`);
    await client.query(`SET LOCAL max_parallel_workers_per_gather = 0`);
    const out = await run(client);
    await client.query('COMMIT');
    const queryMs = Date.now() - tWork;
    const totalMs = Date.now() - tAll;
    logSearchDbTiming('search_transaction', acquireMs, queryMs, totalMs, {});
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

const SELECT_COLS_FROM_SCOPED_CANDIDATE = `
  m.id,
  m.content,
  m.author_id        AS "authorId",
  COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
  m.channel_id       AS "channelId",
  m.conversation_id  AS "conversationId",
  m.created_at       AS "createdAt",
  sc.community_id    AS "communityId",
  sc.channel_name    AS "channelName"`;

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

function p(params: any[], v: any): string {
  params.push(v);
  return `$${params.length}`;
}

function buildAuthorTimeFilters(
  params: any[],
  opts: Record<string, any>,
  alias = 'm',
): string {
  const parts: string[] = [];
  if (opts.authorId) parts.push(`AND ${alias}.author_id = ${p(params, opts.authorId)}`);
  if (opts.after)    parts.push(`AND ${alias}.created_at >= ${p(params, opts.after)}::timestamptz`);
  if (opts.before)   parts.push(`AND ${alias}.created_at <= ${p(params, opts.before)}::timestamptz`);
  return parts.join('\n');
}

function buildFilters(params: any[], opts: Record<string, any>): string {
  const parts: string[] = [];

  if (opts.channelId) {
    parts.push(`AND m.channel_id = ${p(params, opts.channelId)}`);
  } else if (opts.conversationId) {
    parts.push(`AND m.conversation_id = ${p(params, opts.conversationId)}`);
  } else if (opts.communityId) {
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
  }

  const authorTimeFilters = buildAuthorTimeFilters(params, opts);
  if (authorTimeFilters) parts.push(authorTimeFilters);

  return parts.join('\n');
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
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const ctes = [`search_query AS (SELECT websearch_to_tsquery('english', $1) AS q)`];
  if (scope) ctes.push(scope.cte.trim());

  // Keep the expensive result phase bounded. For community-scoped FTS we first
  // materialize TSV hits only within accessible community channels, then cap
  // recency before fetching message/user rows for highlighting.
  const rawCandidatesLimit = parseInt(process.env.SEARCH_FTS_CANDIDATES_LIMIT || '200', 10);
  const minimumCandidates = Math.max(offset + limit, limit);
  const candidatesLimit = Math.max(
    Number.isFinite(rawCandidatesLimit) && rawCandidatesLimit > 0 ? rawCandidatesLimit : 200,
    minimumCandidates,
  );

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
    throw new Error('FTS search requires communityId, channelId, or conversationId');
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

    ctes.push(`fts_candidates AS MATERIALIZED (
      SELECT m0.id, m0.created_at, m0.channel_id
      FROM messages m0
      CROSS JOIN search_query sq0
      INNER JOIN community_channels cc0 ON cc0.id = m0.channel_id
      WHERE m0.deleted_at IS NULL
        AND m0.content_tsv @@ sq0.q
        ${candidateFilters.join('\n        ')}
      ORDER BY m0.created_at DESC, m0.id DESC
      LIMIT ${candidatesLimit}
    )`);

    ctes.push(`fts_candidate_stats AS (
      SELECT COUNT(*)::int AS fts_candidate_count FROM fts_candidates
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
      LIMIT ${candidatesLimit}
    )`);

    selectCols = SELECT_COLS_FROM_SCOPED_CANDIDATE;
    finalFromClause = `
      FROM scoped_candidates sc
      JOIN messages m ON m.id = sc.id
      CROSS JOIN search_query sq
      JOIN users u ON u.id = m.author_id`;
    orderBy = 'sc.created_at DESC, m.id DESC';
  } else if (scope.scopeType === 'channel' && scope.targetIdPh && scope.userIdPh) {
    ctes.push(`fts_candidates AS MATERIALIZED (
      SELECT m0.id, m0.created_at
      FROM messages m0
      CROSS JOIN search_query sq0
      INNER JOIN channels ch_gate ON ch_gate.id = m0.channel_id
        AND ch_gate.id = ${scope.targetIdPh}
      LEFT JOIN channel_members cm_gate
        ON cm_gate.channel_id = ch_gate.id
       AND cm_gate.user_id = ${scope.userIdPh}
      WHERE m0.deleted_at IS NULL
        AND m0.channel_id = ${scope.targetIdPh}
        AND (ch_gate.is_private = FALSE OR cm_gate.user_id IS NOT NULL)
        AND m0.content_tsv @@ sq0.q
        ${candidateFilters.join('\n        ')}
      ORDER BY m0.created_at DESC, m0.id DESC
      LIMIT ${candidatesLimit}
    )`);
    filters = '';
  } else if (scope.scopeType === 'conversation' && scope.targetIdPh && scope.userIdPh) {
    ctes.push(`fts_candidates AS MATERIALIZED (
      SELECT m0.id, m0.created_at
      FROM messages m0
      CROSS JOIN search_query sq0
      INNER JOIN conversation_participants cp_gate
        ON cp_gate.conversation_id = m0.conversation_id
       AND cp_gate.conversation_id = ${scope.targetIdPh}
       AND cp_gate.user_id = ${scope.userIdPh}
       AND cp_gate.left_at IS NULL
      WHERE m0.deleted_at IS NULL
        AND m0.conversation_id = ${scope.targetIdPh}
        AND m0.content_tsv @@ sq0.q
        ${candidateFilters.join('\n        ')}
      ORDER BY m0.created_at DESC, m0.id DESC
      LIMIT ${candidatesLimit}
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
      SELECT ${selectCols},
        ts_headline(
          'english',
          coalesce(m.content, ''),
          sq.q,
          'MaxWords=30, MinWords=15, StartSel=%%EM_START%%, StopSel=%%EM_END%%, HighlightAll=FALSE'
        ) AS highlight,
        ts_rank(m.content_tsv, sq.q) AS _rank
      ${finalFromClause}
      WHERE m.deleted_at IS NULL
        AND m.content_tsv @@ sq.q
        ${filters}
      ORDER BY ${orderBy}
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

function buildScopedLiteralParts(q: string, opts: Record<string, any>) {
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
  // recent candidate cap, page limit, offset.
  const authorTimeFilters = buildAuthorTimeFilters(params, opts, 'm0');
  const rawQueryPh = p(params, q);
  const recentCapPh = p(params, literalRecentCandidateCap());
  const limitPh = p(params, limit);
  const offsetPh = p(params, offset);

  if (scope.scopeType === 'community') {
    const communityChannelCapPh = p(params, literalCommunityChannelCap());
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
        community_channels_limited AS MATERIALIZED (
          SELECT cc.id,
                 cc.community_id,
                 cc.name
          FROM community_channels cc
          LEFT JOIN LATERAL (
            SELECT m1.created_at
            FROM messages m1
            WHERE m1.deleted_at IS NULL
              AND m1.channel_id = cc.id
            ORDER BY m1.created_at DESC, m1.id DESC
            LIMIT 1
          ) latest ON TRUE
          ORDER BY latest.created_at DESC NULLS LAST, cc.id ASC
          LIMIT (${communityChannelCapPh})::int
        )
        SELECT scope_access.has_access AS "__scopeAccess",
          search_rows.*
        FROM scope_access
        LEFT JOIN LATERAL (
          SELECT m.id,
                 m.content,
                 m.author_id        AS "authorId",
                 COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
                 m.channel_id       AS "channelId",
                 m.conversation_id  AS "conversationId",
                 m.created_at       AS "createdAt",
                 cc.community_id    AS "communityId",
                 cc.name            AS "channelName"
          FROM community_channels_limited cc
          JOIN LATERAL (
            SELECT m0.id,
                   m0.content,
                   m0.author_id,
                   m0.channel_id,
                   m0.conversation_id,
                   m0.created_at
            FROM messages m0
            WHERE m0.deleted_at IS NULL
              AND m0.channel_id = cc.id
              ${authorTimeFilters}
            ORDER BY m0.created_at DESC, m0.id DESC
            LIMIT ${recentCapPh}
          ) m ON TRUE
          JOIN users u ON u.id = m.author_id
          WHERE position(lower(${rawQueryPh}) in lower(coalesce(m.content, ''))) > 0
          ORDER BY m.created_at DESC, m.id DESC
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
          WHERE position(lower(${rawQueryPh}) in lower(coalesce(m.content, ''))) > 0
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${limitPh} OFFSET ${offsetPh}
        ) search_rows ON scope_access.has_access = TRUE`,
      params,
      limit,
      offset,
      q,
    };
  }

  if (scope.scopeType === 'channel' && scope.targetIdPh && scope.userIdPh) {
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
            INNER JOIN channels ch_gate
              ON ch_gate.id = m0.channel_id
             AND ch_gate.id = ${scope.targetIdPh}
            LEFT JOIN channel_members cm_gate
              ON cm_gate.channel_id = ch_gate.id
             AND cm_gate.user_id = ${scope.userIdPh}
            WHERE m0.deleted_at IS NULL
              AND m0.channel_id = ${scope.targetIdPh}
              AND (ch_gate.is_private = FALSE OR cm_gate.user_id IS NOT NULL)
              ${authorTimeFilters}
            ORDER BY m0.created_at DESC, m0.id DESC
            LIMIT ${recentCapPh}
          ) m
          JOIN users u ON u.id = m.author_id
          LEFT JOIN channels ch ON ch.id = m.channel_id
          WHERE position(lower(${rawQueryPh}) in lower(coalesce(m.content, ''))) > 0
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

function shouldRetrySearchOnPrimary(
  forcePrimary: boolean,
  result: { hits?: any[] } | null,
  err?: any,
) {
  if (forcePrimary || !SEARCH_USE_READ_REPLICA || !db.readPool) return false;
  if (err?.statusCode === 403) return true;
  return Array.isArray(result?.hits) && result!.hits.length === 0;
}

/**
 * search – main entry point. FTS-only.
 *
 * Scoped searches run FTS first. When FTS returns no hits, a bounded literal
 * substring match runs inside the same scope (no trigram, no cross-scope scan).
 * Queries without communityId, channelId, or conversationId return no hits.
 *
 * @param q     Raw query string (validated by caller: non-empty when present)
 * @param opts  { channelId?, conversationId?, communityId?, userId, authorId?, after?, before?, limit?, offset?, requestId? }
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
    const tMeta = Date.now();
    const tsqueryMetaRes = await client.query(
      `SELECT websearch_to_tsquery('english', $1)::text AS tsquery_text,
              numnode(websearch_to_tsquery('english', $1)) AS tsquery_nodes`,
      [trimmed],
    );
    queryMsAccum += Date.now() - tMeta;
    const tsqueryText = String(tsqueryMetaRes.rows[0]?.tsquery_text ?? '');
    const tsqueryNodes = Number(tsqueryMetaRes.rows[0]?.tsquery_nodes || 0);

    const ftsMeta = buildFtsParts(trimmed, opts);
    const tFts = Date.now();
    const ftsRes = await client.query(ftsMeta.sql, ftsMeta.params);
    queryMsAccum += Date.now() - tFts;
    if (ftsRes.rows[0]?.__scopeAccess === false) {
      const err: any = new Error('Access denied');
      err.statusCode = 403;
      throw err;
    }

    const ftsHits = ftsRes.rows.filter((row: any) => row && row.id);
    const ftsHitCount = ftsHits.length;
    const communityFtsCandidateCount =
      scopeLabel === 'community'
        ? ftsRes.rows.find((r: any) => r && r.fts_candidate_count != null)?.fts_candidate_count
        : undefined;

    if (ftsHitCount > 0) {
      const totalMs = Date.now() - tSearchStart;
      logSearchTrace({
        requestId,
        query: trimmed,
        resolved_scope: scopeLabel,
        tsquery_text: tsqueryText,
        tsquery_node_count: tsqueryNodes,
        fts_hit_count: ftsHitCount,
        fallback_used: false,
        fallback_hit_count: 0,
        total_ms: totalMs,
        query_ms: queryMsAccum,
        ...(scopeLabel === 'community'
          ? {
              fts_candidate_count: communityFtsCandidateCount,
              result_count: ftsHitCount,
            }
          : {}),
      });
      return buildResult(ftsRes.rows, ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
    }

    const literalMeta = buildScopedLiteralParts(trimmed, opts);
    const tLit = Date.now();
    const literalRes = await client.query(literalMeta.sql, literalMeta.params);
    queryMsAccum += Date.now() - tLit;
    if (literalRes.rows[0]?.__scopeAccess === false) {
      const err: any = new Error('Access denied');
      err.statusCode = 403;
      throw err;
    }
    const fallbackHits = literalRes.rows.filter((row: any) => row && row.id);
    const totalMs = Date.now() - tSearchStart;
    logSearchTrace({
      requestId,
      query: trimmed,
      resolved_scope: scopeLabel,
      tsquery_text: tsqueryText,
      tsquery_node_count: tsqueryNodes,
      fts_hit_count: 0,
      fallback_used: true,
      fallback_hit_count: fallbackHits.length,
      total_ms: totalMs,
      query_ms: queryMsAccum,
      ...(scopeLabel === 'community'
        ? {
            fts_candidate_count: communityFtsCandidateCount,
            result_count: fallbackHits.length,
          }
        : {}),
    });
    return buildResult(literalRes.rows, literalMeta.q, literalMeta.offset, literalMeta.limit);
  }, { forcePrimary });
}

// ── Meili-backed search path ──────────────────────────────────────────────────

const MEILI_STRICT_TERM_MIN_LEN = 2;

/**
 * Split a user query into lowercase terms for strict substring AND matching
 * (Postgres FTS uses stemming/stopwords; Meili is permissive on typos — this
 * layer enforces "every meaningful token appears in content" before returning).
 */
function tokenizeStrictSearchTerms(raw: string): string[] {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+/gu, '').replace(/[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length >= MEILI_STRICT_TERM_MIN_LEN);
}

function messageMatchesAllStrictTerms(content: unknown, terms: string[]): boolean {
  if (!terms.length) return true;
  const c = String(content || '').toLowerCase();
  return terms.every((t) => c.includes(t));
}

/**
 * Given candidate IDs returned by Meilisearch, recheck every one in Postgres:
 *   – permission gates (community membership, channel access, DM participation)
 *   – deleted_at IS NULL
 *   – author / time filters
 *   – returns newest-first within the candidate set
 *
 * This function must always be called before returning search results to a client
 * when SEARCH_BACKEND=meili is active.  It is the sole permission enforcement point
 * for the Meili path.
 */
function buildRecheckFromCandidates(
  ids: string[],
  q: string,
  opts: Record<string, any>,
) {
  const params: any[] = [];
  const scope = buildScopedAccessParts(params, opts);
  const idsPh = p(params, ids);
  const filters = buildFilters(params, opts);
  const limit   = Number(opts.limit)  || 20;
  const offset  = Number(opts.offset) || 0;
  const limitPh  = p(params, limit);
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

  // 1 – Candidate generation via Meilisearch
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
    // Throw a typed sentinel so the caller knows to use the Postgres path.
    const fe: any = new Error('meili_unavailable');
    fe.meiliUnavailable = true;
    throw fe;
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
    const fe: any = new Error('meili_empty_candidates');
    fe.meiliUnavailable = true;
    throw fe;
  }

  // 2 – Postgres recheck (permission enforcement + freshness)
  const tRecheck = Date.now();
  const recheckMeta = buildRecheckFromCandidates(ids, q, opts);
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

  if (strictRows.length === 0 && ids.length > 0) {
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
        postgres_rechecked_count: rows.filter((r: any) => r && r.id).length,
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
    const initialForcePrimary = !SEARCH_USE_READ_REPLICA;
    return searchOnce(q, opts, initialForcePrimary);
  }

  const finalHits = strictRows.filter((r: any) => r && r.id);
  const totalMs = Date.now() - tAll;

  logger.info(
    {
      search_trace: true,
      requestId,
      query: q,
      resolved_scope: scopeLabel,
      search_backend: 'meili',
      meili_candidate_count: ids.length,
      postgres_rechecked_count: rows.filter((r: any) => r && r.id).length,
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
    logger.info(
      {
        query: trimmed,
        communityId: opts.communityId,
        channelId: opts.channelId,
        conversationId: opts.conversationId,
      },
      'search: replica returned empty result set, retrying on primary',
    );
    return await searchOnce(trimmed, opts, true);
  } catch (err) {
    if (!shouldRetrySearchOnPrimary(initialForcePrimary, null, err)) {
      throw err;
    }
    logger.info(
      {
        query: trimmed,
        communityId: opts.communityId,
        channelId: opts.channelId,
        conversationId: opts.conversationId,
      },
      'search: replica access check may be stale, retrying on primary',
    );
    return searchOnce(trimmed, opts, true);
  }
}

module.exports =
  process.env.NODE_ENV === 'test'
    ? { search, __testBuildScopedLiteralParts: buildScopedLiteralParts }
    : { search };
