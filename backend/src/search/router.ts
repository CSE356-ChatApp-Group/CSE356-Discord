/**
 * Search routes
 *
 * GET /api/v1/search?q=&communityId=&conversationId=&authorId=&after=&before=&limit=&offset=
 *
 * Scope: communityId or conversationId (exactly one required).
 * communityId and conversationId are mutually exclusive; requests that
 * include both are rejected with 400.
 * Omitting both is rejected; this route is intentionally scoped-only.
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { searchLimiter } = require('../middleware/inMemoryApiLimiter');
const searchClient = require('./client');
const overload = require('../utils/overload');
const logger = require('../utils/logger');
const {
  getShouldDeferReadReceiptForInsertLockPressure,
} = require('../messages/messageInsertLockPressure');

const router = express.Router();
router.use(authenticate);
router.use(searchLimiter);

function clampSearchPaging(limitRaw, offsetRaw) {
  const maxLimit = Math.min(Math.max(parseInt(process.env.SEARCH_MAX_LIMIT || '50', 10), 1), 100);
  const maxOffset = Math.min(Math.max(parseInt(process.env.SEARCH_MAX_OFFSET || '500', 10), 0), 2000);
  const lim = Math.min(Math.max(parseInt(String(limitRaw || '20'), 10) || 20, 1), maxLimit);
  const off = Math.min(Math.max(parseInt(String(offsetRaw || '0'), 10) || 0, 0), maxOffset);
  return { limit: lim, offset: off };
}

router.get('/', async (req, res, next) => {
  const startMs = Date.now();
  try {
    if (getShouldDeferReadReceiptForInsertLockPressure()) {
      return res.status(503).json({
        error: 'Search temporarily unavailable while messaging is under load; please retry.',
      });
    }
    let { q, communityId, conversationId, authorId, after, before, limit, offset } = req.query;
    const allowedQueryParams = new Set([
      'q',
      'communityId',
      'conversationId',
      'authorId',
      'after',
      'before',
      'limit',
      'offset',
    ]);
    const unsupportedParam = Object.keys(req.query || {}).find((key) => !allowedQueryParams.has(key));
    if (unsupportedParam) {
      return res.status(400).json({
        error: 'Unsupported search parameter; allowed params are q, communityId, conversationId, authorId, after, before, limit, offset'
      });
    }
    if (overload.shouldRejectSearchRequests()) {
      return res.status(503).json({ error: 'Search temporarily unavailable under high load' });
    }

    if (communityId && conversationId) {
      return res.status(400).json({
        error: 'Search must be scoped: provide either communityId or conversationId, not both'
      });
    }
    if (!communityId && !conversationId) {
      return res.status(400).json({
        error: 'Search must be scoped: provide either communityId or conversationId'
      });
    }

    const normalizedQuery = String(q || '').trim();
    const hasFilterOnlySearch = Boolean(authorId || after || before);

    if (!normalizedQuery && !hasFilterOnlySearch) {
      return res.status(400).json({ error: 'Provide a query or at least one search filter' });
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (authorId && !UUID_RE.test(String(authorId))) {
      return res.status(400).json({ error: 'authorId must be a valid UUID' });
    }

    const { limit: clampedLimit, offset: clampedOffset } = clampSearchPaging(limit, offset);
    const adjustedLimit = overload.searchLimit(clampedLimit);
    const results = await searchClient.search(normalizedQuery, {
      communityId, conversationId, authorId, after, before,
      userId: req.user.id,
      limit: adjustedLimit,
      offset: clampedOffset,
      requestId: req.id,
    });

    const durationMs = Date.now() - startMs;
    const queryMeta = {
      queryLength: normalizedQuery.length,
      hasQueryText: Boolean(normalizedQuery),
      scope: communityId ? 'community' : (conversationId ? 'conversation' : 'unknown'),
      hasFilters: Boolean(authorId || after || before),
      hitCount: results?.hits?.length || 0,
      durationMs,
    };

    // Log all search requests to identify patterns
    logger.debug(queryMeta, 'search request completed');

    // Flag slow searches for deeper analysis
    if (durationMs > 500) {
      logger.warn(
        { ...queryMeta, query: normalizedQuery },
        `SLOW SEARCH: ${durationMs}ms (>500ms threshold)`
      );
    }
    if (durationMs > 1000) {
      logger.warn(
        { ...queryMeta, query: normalizedQuery },
        `VERY SLOW SEARCH: ${durationMs}ms (>1s threshold)`
      );
    }
    if (durationMs > 2000) {
      logger.error(
        { ...queryMeta, query: normalizedQuery },
        `CRITICAL SLOW SEARCH: ${durationMs}ms (>2s threshold)`
      );
    }

    res.json(results);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    if (err?.statusCode === 403) {
      logger.debug({ durationMs }, 'search: access denied');
      return res.status(403).json({ error: 'Access denied' });
    }
    logger.error({ err, durationMs }, 'search request failed');
    next(err);
  }
});

module.exports = router;
