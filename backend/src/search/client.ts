/**
 * Search client – wraps Meilisearch for message indexing and querying.
 *
 * Index: "messages"
 * Indexed fields: id, content, authorId, channelId, conversationId, communityId, createdAt
 *
 * To switch to OpenSearch: implement the same interface using the
 * @opensearch-project/opensearch package.
 */

'use strict';

const { MeiliSearch } = require('meilisearch');
const { pool } = require('../db/pool');
const logger = require('../utils/logger');

const useMeilisearch = process.env.USE_MEILISEARCH === 'true';
const client = useMeilisearch
  ? new MeiliSearch({
      host: process.env.MEILISEARCH_URL || 'http://localhost:7700',
      apiKey: process.env.MEILISEARCH_KEY || '',
    })
  : null;

const INDEX = 'messages';
const searchInitDisabled =
  !useMeilisearch ||
  process.env.DISABLE_SEARCH_INIT === 'true' ||
  process.env.NODE_ENV === 'test';

async function ensureIndex() {
  try {
    await client.getIndex(INDEX);
  } catch {
    await client.createIndex(INDEX, { primaryKey: 'id' });
    const index = client.index(INDEX);
    await index.updateSettings({
      searchableAttributes: ['content'],
      filterableAttributes: ['channelId', 'conversationId', 'communityId', 'authorId', 'createdAt'],
      sortableAttributes: ['createdAt'],
    });
    logger.info('Meilisearch index created');
  }
}

if (!searchInitDisabled) {
  ensureIndex().catch(err => logger.warn({ err }, 'Meilisearch init warning'));
}

async function indexMessage(msg) {
  if (!useMeilisearch) return;
  await client.index(INDEX).addDocuments([{
    id:             msg.id,
    content:        msg.content || '',
    authorId:       msg.author_id,
    channelId:      msg.channel_id || null,
    conversationId: msg.conversation_id || null,
    communityId:    msg.community_id || null,
    createdAt:      msg.created_at,
  }]);
}

async function deleteMessage(id) {
  if (!useMeilisearch) return;
  await client.index(INDEX).deleteDocument(id);
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(content, query) {
  if (!content) return '';
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp);
  if (!terms.length) return content;

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  return content.replace(pattern, '<em>$1</em>');
}

async function attachAuthorDisplayNames(hits = []) {
  const authorIds = [...new Set(
    hits
      .map(hit => hit?.authorId)
      .filter(Boolean)
      .map(String)
  )];

  if (!authorIds.length) return hits;

  const { rows } = await pool.query(
    `SELECT id::text AS id,
            COALESCE(NULLIF(display_name, ''), username) AS "authorDisplayName"
     FROM users
     WHERE id::text = ANY($1::text[])`,
    [authorIds]
  );

  const nameById = new Map(rows.map(row => [row.id, row.authorDisplayName]));
  return hits.map(hit => ({
    ...hit,
    authorDisplayName: hit.authorDisplayName || nameById.get(String(hit.authorId)) || 'User',
  }));
}

async function searchPostgres(q, opts: Record<string, any> = {}) {
  const params: any[] = [`%${q}%`];
  const where = ['m.deleted_at IS NULL', `m.content ILIKE $${params.length}`];

  if (opts.channelId) {
    params.push(opts.channelId);
    where.push(`m.channel_id = $${params.length}`);
  }
  if (opts.conversationId) {
    params.push(opts.conversationId);
    where.push(`m.conversation_id = $${params.length}`);
  }
  if (opts.authorId) {
    params.push(opts.authorId);
    where.push(`m.author_id = $${params.length}`);
  }
  if (opts.after) {
    params.push(opts.after);
    where.push(`m.created_at >= $${params.length}::timestamptz`);
  }
  if (opts.before) {
    params.push(opts.before);
    where.push(`m.created_at <= $${params.length}::timestamptz`);
  }

  const limit = Number(opts.limit) || 20;
  const offset = Number(opts.offset) || 0;
  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  const { rows } = await pool.query(
    `SELECT m.id,
            m.content,
            m.author_id AS "authorId",
            COALESCE(NULLIF(u.display_name, ''), u.username) AS "authorDisplayName",
            m.channel_id AS "channelId",
            m.conversation_id AS "conversationId",
            m.created_at AS "createdAt"
     FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT $${limitIndex}
     OFFSET $${offsetIndex}`,
    params
  );

  const hits = rows.map(row => ({
    ...row,
    _formatted: {
      content: highlight(row.content, q),
    },
  }));

  return {
    hits,
    offset,
    limit,
    estimatedTotalHits: hits.length,
    processingTimeMs: 0,
    query: q,
  };
}

async function searchMeilisearch(q, opts: Record<string, any> = {}) {
  const filters = [];

  if (opts.channelId)      filters.push(`channelId = "${opts.channelId}"`);
  if (opts.conversationId) filters.push(`conversationId = "${opts.conversationId}"`);
  if (opts.authorId)       filters.push(`authorId = "${opts.authorId}"`);
  if (opts.after)          filters.push(`createdAt >= "${opts.after}"`);
  if (opts.before)         filters.push(`createdAt <= "${opts.before}"`);

  const result = await client.index(INDEX).search(q, {
    filter: filters.join(' AND ') || undefined,
    limit:  opts.limit  || 20,
    offset: opts.offset || 0,
    sort:   ['createdAt:desc'],
  });

  return {
    ...result,
    hits: await attachAuthorDisplayNames(result.hits || []),
  };
}

/**
 * search – full-text search with optional filters
 *
 * @param {string}   q          – query string
 * @param {object}   opts
 * @param {string}   opts.channelId
 * @param {string}   opts.conversationId
 * @param {string}   opts.authorId
 * @param {string}   opts.after  – ISO timestamp lower bound
 * @param {string}   opts.before – ISO timestamp upper bound
 * @param {number}   opts.limit
 * @param {number}   opts.offset
 */
async function search(q, opts: Record<string, any> = {}) {
  if (!useMeilisearch) {
    return searchPostgres(q, opts);
  }

  try {
    return await searchMeilisearch(q, opts);
  } catch (err) {
    logger.warn({ err }, 'Meilisearch query failed, falling back to Postgres search');
    return searchPostgres(q, opts);
  }
}

module.exports = { indexMessage, deleteMessage, search };
