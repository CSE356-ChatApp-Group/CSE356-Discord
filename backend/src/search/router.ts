/**
 * Search routes
 *
 * GET /api/v1/search?q=&communityId=&channelId=&conversationId=&authorId=&after=&before=&limit=&offset=
 *
 * Scope: communityId, channelId, and/or conversationId (see handler: when
 * channelId === conversationId, only conversation scope is used — matches
 * COMPAS generated client searchMessages URL).
 * Omitting all three is rejected; this route is intentionally scoped-only.
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const searchClient = require('./client');
const overload = require('../utils/overload');

const router = express.Router();
router.use(authenticate);

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
    let { q, communityId, channelId, conversationId, authorId, after, before, limit, offset } = req.query;
    // COMPAS generated client sends `channelId=<id>&conversationId=<id>` with the same UUID
    // for DM/conversation-scoped search; we must not treat that id as a channel first.
    if (
      channelId
      && conversationId
      && String(channelId) === String(conversationId)
    ) {
      channelId = undefined;
    }
    if (overload.shouldRejectSearchRequests()) {
      return res.status(503).json({ error: 'Search temporarily unavailable under high load' });
    }

    // Search must be scoped per assignment: either communityId, channelId, or conversationId
    // Unscoped searches (omitting all three) are disallowed to prevent expensive cross-scope scans.
    const isScoped = Boolean(communityId || channelId || conversationId);
    if (!isScoped) {
      return res.status(400).json({
        error: 'Search must be scoped: provide communityId, channelId, or conversationId'
      });
    }

    const normalizedQuery = String(q || '').trim();
    const hasFilterOnlySearch = Boolean(authorId || after || before);

    if (!normalizedQuery && !hasFilterOnlySearch) {
      return res.status(400).json({ error: 'Provide a query or at least one search filter' });
    }

    const { limit: clampedLimit, offset: clampedOffset } = clampSearchPaging(limit, offset);
    const adjustedLimit = overload.searchLimit(clampedLimit);
    const results = await searchClient.search(normalizedQuery, {
      communityId, channelId, conversationId, authorId, after, before,
      userId: req.user.id,
      limit: adjustedLimit,
      offset: clampedOffset,
    });

    const durationMs = Date.now() - startMs;
    const queryMeta = {
      queryLength: normalizedQuery.length,
      hasQueryText: Boolean(normalizedQuery),
      scope: communityId ? 'community' : (channelId ? 'channel' : (conversationId ? 'conversation' : 'unknown')),
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
