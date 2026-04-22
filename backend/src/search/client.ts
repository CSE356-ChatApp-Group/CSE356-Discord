/**
 * Search client – Postgres native full-text search (FTS only).
 *
 * Primary path:  websearch_to_tsquery + tsvector GIN index
 *                (ranked via ts_rank, highlighted via ts_headline)
 *
 * Access control is built into the query:
 *   - Scoped: a `scope_access` CTE preserves 403 behavior without a second DB trip.
 *   - Unscoped: the query restricts results to channels/conversations the
 *     requesting user belongs to.
 */

'use strict';

const db = require('../db/pool');
const { getClientTimed } = db;
const logger = require('../utils/logger');
const overload = require('../utils/overload');

const SEARCH_USE_READ_REPLICA =
  String(process.env.SEARCH_USE_READ_REPLICA || '').trim().toLowerCase() === 'true';

function getSearchStatementTimeoutMs() {
  const rawMs = process.env.SEARCH_STATEMENT_TIMEOUT_MS;
  const configuredMs = Math.min(Math.max(parseInt(rawMs || '10000', 10), 1000), 120000);
  const stage = overload.getStage();
  if (stage >= 2) return Math.min(configuredMs, 2000);
  if (stage >= 1) return Math.min(configuredMs, 3000);
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
  } else if (opts.userId) {
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

/** Statement + paging metadata for FTS (content_tsv GIN). */
function buildFtsParts(q: string, opts: Record<string, any>) {
  const params: any[] = [q]; // $1 reserved for the query string
  const scope = buildScopedAccessParts(params, opts);
  const filters = buildFilters(params, opts);
  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  const limitPh = p(params, limit);
  const offsetPh = p(params, offset);
  const ctes = [`search_query AS (SELECT websearch_to_tsquery('english', $1) AS q)`];
  if (scope) ctes.push(scope.cte.trim());

  // Candidates CTE caps the GIN index scan before per-row access control runs for
  // community/unscoped queries. Without it a common term returns thousands of TSV
  // matches and the per-row EXISTS subquery runs O(matches) times.
  const isUnscoped = Boolean(opts.userId && !opts.channelId && !opts.conversationId && !opts.communityId);
  const isCommunityScoped = Boolean(opts.communityId && !opts.channelId && !opts.conversationId);
  const rawCandidatesLimit = parseInt(process.env.SEARCH_UNSCOPED_CANDIDATES_LIMIT || '200', 10);
  const candidatesLimit = Number.isFinite(rawCandidatesLimit) && rawCandidatesLimit > 0 ? rawCandidatesLimit : 200;

  let innerFromClause = FTS_FROM_CLAUSE;
  let innerWhereExtra = '';
  const communityCandidateParts = buildCommunityScopedCandidateParts(scope, 'm0', 'ch_scope', 'cm_scope');

  if (isCommunityScoped && communityCandidateParts && scope) {
    ctes.push(`candidates AS (
      SELECT m0.id
      FROM messages m0
      WHERE m0.deleted_at IS NULL
        AND m0.channel_id IS NOT NULL
        AND m0.content_tsv @@ (SELECT q FROM search_query)
        AND EXISTS (
          SELECT 1
          FROM channels ch_scope
          LEFT JOIN channel_members cm_scope
            ON cm_scope.channel_id = ch_scope.id
           AND cm_scope.user_id = ${scope.userIdPh}
          WHERE ch_scope.id = m0.channel_id
            AND ch_scope.community_id = ${scope.targetIdPh}
            AND (ch_scope.is_private = FALSE OR cm_scope.user_id IS NOT NULL)
        )
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
        ${filters}
      ORDER BY m.created_at DESC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    ) search_rows ${scope ? scope.onClause : ''}`;

  return { sql, params, limit, offset, q };
}

async function searchFilteredOnly(
  opts: Record<string, any>,
  forcePrimary = false,
): Promise<any> {
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
 * Stop-word-only queries (e.g. "the and is") collapse to ''::tsquery via
 * websearch_to_tsquery('english') and return an empty result immediately —
 * no fallback scan is attempted.
 *
 * @param q     Raw query string (validated by caller: non-empty when present)
 * @param opts  { channelId?, conversationId?, communityId?, userId, authorId?, after?, before?, limit?, offset? }
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
  const scoped = Boolean(opts.channelId || opts.conversationId || opts.communityId);
  const ftsMeta = buildFtsParts(trimmed, opts);

  return await runSearchTransaction(async (client) => {
    const ftsRes = await client.query(ftsMeta.sql, ftsMeta.params);
    if (scoped && ftsRes.rows[0]?.__scopeAccess === false) {
      const err: any = new Error('Access denied');
      err.statusCode = 403;
      throw err;
    }
    return buildResult(ftsRes.rows, ftsMeta.q, ftsMeta.offset, ftsMeta.limit);
  }, { forcePrimary });
}

async function search(q: string, opts: Record<string, any> = {}): Promise<any> {
  const trimmed = String(q || '').trim();
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

module.exports = { search };
