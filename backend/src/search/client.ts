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
const logger = require('../utils/logger');

const client = new MeiliSearch({
  host: process.env.MEILISEARCH_URL || 'http://localhost:7700',
  apiKey: process.env.MEILISEARCH_KEY || '',
});

const INDEX = 'messages';
const searchInitDisabled = process.env.DISABLE_SEARCH_INIT === 'true' || process.env.NODE_ENV === 'test';

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
  await client.index(INDEX).deleteDocument(id);
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

  return result;
}

module.exports = { indexMessage, deleteMessage, search };
