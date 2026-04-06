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
 *   - Scoped (channelId / conversationId): verified by the router before this
 *     function is called; the scope param is used as a direct WHERE filter.
 *   - Unscoped: the query restricts results to channels/conversations the
 *     requesting user belongs to.
 */

'use strict';

const { query } = require('../db/pool');
const logger = require('../utils/logger');

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
    const uid = p(params, opts.userId);
    parts.push(`
    AND (
      (m.channel_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM channels ch
        LEFT JOIN channel_members cm ON cm.channel_id = ch.id AND cm.user_id = ${uid}
        WHERE ch.id = m.channel_id
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

function highlightIlike(content: string, q: string): string {
  if (!content) return '';
  // HTML-escape first, then insert <em> markers so the output is safe for innerHTML.
  const safe = escapeHtml(content);
  const terms = q.trim().split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join('|')})`, 'gi'), '<em>$1</em>');
}

function buildResult(rows: any[], q: string, offset: number, limit: number) {
  return {
    hits: rows.map(row => ({
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
    estimatedTotalHits: rows.length,
    processingTimeMs: 0,
    query: q,
  };
}

/** Primary: ranked FTS via the content_tsv GIN index. */
async function searchFts(q: string, opts: Record<string, any>): Promise<any> {
  const params: any[] = [q];    // $1 reserved for the query string
  const filters  = buildFilters(params, opts);
  const limit    = Number(opts.limit)  || 20;
  const offset   = Number(opts.offset) || 0;
  const limitPh  = p(params, limit);
  const offsetPh = p(params, offset);

  const sql = `
    SELECT ${SELECT_COLS},
      ts_headline(
        'english',
        coalesce(m.content, ''),
        websearch_to_tsquery('english', $1),
        'MaxWords=30, MinWords=15, StartSel=%%EM_START%%, StopSel=%%EM_END%%, HighlightAll=FALSE'
      ) AS highlight,
      ts_rank(m.content_tsv, websearch_to_tsquery('english', $1)) AS _rank
    ${FROM_CLAUSE}
    WHERE m.deleted_at IS NULL
      AND m.content_tsv @@ websearch_to_tsquery('english', $1)
      ${filters}
    ORDER BY m.created_at DESC
    LIMIT ${limitPh} OFFSET ${offsetPh}`;

  const { rows } = await query(sql, params);
  return buildResult(rows, q, offset, limit);
}

/**
 * Fallback: ILIKE via the existing pg_trgm GIN index.
 * Activates when FTS returns 0 results — handles partial/infix queries
 * ("hel" matching "hello") and queries whose lexemes are all stop words.
 */
async function searchTrigram(q: string, opts: Record<string, any>): Promise<any> {
  const params: any[] = [`%${q}%`];   // $1 reserved for the ILIKE pattern
  const filters  = buildFilters(params, opts);
  const limit    = Number(opts.limit)  || 20;
  const offset   = Number(opts.offset) || 0;
  const limitPh  = p(params, limit);
  const offsetPh = p(params, offset);

  const sql = `
    SELECT ${SELECT_COLS}
    ${FROM_CLAUSE}
    WHERE m.deleted_at IS NULL
      AND m.content ILIKE $1
      ${filters}
    ORDER BY m.created_at DESC
    LIMIT ${limitPh} OFFSET ${offsetPh}`;

  const { rows } = await query(sql, params);
  const processed = rows.map(row => ({ ...row, highlight: highlightIlike(row.content, q) }));
  return buildResult(processed, q, offset, limit);
}

async function searchFilteredOnly(opts: Record<string, any>): Promise<any> {
  const params: any[] = [];
  const filters  = buildFilters(params, opts);
  const limit    = Number(opts.limit)  || 20;
  const offset   = Number(opts.offset) || 0;
  const limitPh  = p(params, limit);
  const offsetPh = p(params, offset);

  const sql = `
    SELECT ${SELECT_COLS}
    ${FROM_CLAUSE}
    WHERE m.deleted_at IS NULL
      ${filters}
    ORDER BY m.created_at DESC
    LIMIT ${limitPh} OFFSET ${offsetPh}`;

  const { rows } = await query(sql, params);
  return buildResult(rows, '', offset, limit);
}

/**
 * search – main entry point.
 *
 * Uses FTS (tsvector GIN index) as the primary path for ranked, stemmed,
 * phrase-aware search.  Falls back to trigram ILIKE when FTS returns zero
 * results so partial/infix queries still resolve.
 *
 * @param q     Raw query string (validated by caller: length ≥ 2)
 * @param opts  { channelId?, conversationId?, userId, authorId?, after?, before?, limit?, offset? }
 */
async function search(q: string, opts: Record<string, any> = {}): Promise<any> {
  if (!String(q || '').trim()) {
    return searchFilteredOnly(opts);
  }

  try {
    const fts = await searchFts(q, opts);
    if (fts.hits.length > 0) return fts;
    return await searchTrigram(q, opts);
  } catch (err) {
    logger.warn({ err }, 'FTS search failed, falling back to trigram');
    try {
      return await searchTrigram(q, opts);
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr }, 'Trigram fallback also failed');
      throw fallbackErr;
    }
  }
}

module.exports = { search };
