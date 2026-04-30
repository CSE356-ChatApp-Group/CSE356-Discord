/**
 * GET / — scoped message search (community or conversation).
 */
const { query } = require('../../db/pool');
const overload = require('../../utils/overload');
const logger = require('../../utils/logger');
const searchClient = require('../client');
const { searchInstanceMeta, clampSearchPaging } = require('../helpers');

module.exports = function registerGetRoutes(router) {
  router.get('/', async (req, res, next) => {
    const startMs = Date.now();
    try {
      let { q, communityId, conversationId, authorId, after, before, limit, offset } = req.query;
      const requestedCommunityId = communityId ? String(communityId) : undefined;
      const requestedConversationId = conversationId ? String(conversationId) : undefined;
      let scopeResolution = 'as_requested';

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
          error:
            'Unsupported search parameter; allowed params are q, communityId, conversationId, authorId, after, before, limit, offset',
        });
      }

      if (overload.shouldRejectSearchRequests()) {
        const responseBody = { error: 'Search temporarily unavailable under high load' };
        logger.warn(
          {
            search_alert_classification: true,
            classification: 'search_throttled',
            reason: 'overload_stage',
            statusCode: 429,
            responseBody,
            requestId: req.id,
            ...searchInstanceMeta(),
          },
          'search classifier: throttled',
        );
        return res.status(429).set('Retry-After', '3').json(responseBody);
      }

      if (communityId && conversationId) {
        const { rows } = await query(
          `SELECT 1
         FROM conversation_participants
         WHERE conversation_id = $1::uuid
           AND user_id = $2::uuid
           AND left_at IS NULL
         LIMIT 1`,
          [conversationId, req.user.id],
        );
        if (rows.length > 0) {
          communityId = undefined;
          scopeResolution = 'both_requested_keep_conversation_participant';
        } else {
          conversationId = undefined;
          scopeResolution = 'both_requested_fallback_to_community_not_participant';
        }
      }

      if (!communityId && !conversationId) {
        return res.status(400).json({
          error: 'Search must be scoped: provide either communityId or conversationId',
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
      const effectiveScope = communityId ? 'community' : conversationId ? 'conversation' : 'unknown';
      const results = await searchClient.search(normalizedQuery, {
        communityId,
        conversationId,
        authorId,
        after,
        before,
        userId: req.user.id,
        limit: adjustedLimit,
        offset: clampedOffset,
        requestId: req.id,
      });
      if ((results?.hits?.length || 0) === 0) {
        logger.info(
          {
            search_alert_classification: true,
            classification: 'search_empty_result',
            statusCode: 200,
            responseBody: { hits: [] },
            requestId: req.id,
            query: normalizedQuery,
            scope: effectiveScope,
            requestedScope: {
              communityId: requestedCommunityId,
              conversationId: requestedConversationId,
            },
            effectiveScopeIds: {
              communityId: communityId ? String(communityId) : undefined,
              conversationId: conversationId ? String(conversationId) : undefined,
            },
            scopeResolution,
            ...searchInstanceMeta(),
          },
          'search classifier: true empty result',
        );
      }

      const durationMs = Date.now() - startMs;
      const queryMeta = {
        queryLength: normalizedQuery.length,
        hasQueryText: Boolean(normalizedQuery),
        scope: effectiveScope,
        requestedScope: {
          communityId: requestedCommunityId,
          conversationId: requestedConversationId,
        },
        effectiveScopeIds: {
          communityId: communityId ? String(communityId) : undefined,
          conversationId: conversationId ? String(conversationId) : undefined,
        },
        scopeResolution,
        hasFilters: Boolean(authorId || after || before),
        hitCount: results?.hits?.length || 0,
        durationMs,
      };

      logger.debug(queryMeta, 'search request completed');

      if (durationMs > 500) {
        logger.warn({ ...queryMeta, query: normalizedQuery }, `SLOW SEARCH: ${durationMs}ms (>500ms threshold)`);
      }
      if (durationMs > 1000) {
        logger.warn({ ...queryMeta, query: normalizedQuery }, `VERY SLOW SEARCH: ${durationMs}ms (>1s threshold)`);
      }
      if (durationMs > 2000) {
        logger.error({ ...queryMeta, query: normalizedQuery }, `CRITICAL SLOW SEARCH: ${durationMs}ms (>2s threshold)`);
      }

      res.json(results);
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      if (err?.statusCode === 403) {
        logger.debug({ durationMs }, 'search: access denied');
        return res.status(403).json({ error: 'Access denied' });
      }
      const msg = String(err?.message || '');
      const code = err?.code;
      const isStmtTimeout =
        code === '57014' || /canceling statement due to statement timeout/i.test(msg);
      const isPoolSat =
        err?.name === 'PoolCircuitBreakerError' ||
        err?.code === 'POOL_CIRCUIT_OPEN' ||
        err?.name === 'PoolTimeoutError' ||
        code === 'ETIMEDOUT' ||
        (/timeout exceeded/i.test(msg) && /(connect|client|connection|waiting)/i.test(msg)) ||
        /remaining connection slots/i.test(msg) ||
        /too many clients/i.test(msg) ||
        (typeof err?.message === 'string' && err.message.toLowerCase().includes('waiting for a client'));
      if (isStmtTimeout) {
        const responseBody = { error: 'Search timed out; try a narrower query or retry shortly.' };
        logger.warn(
          {
            search_alert_classification: true,
            classification: 'search_throttled',
            reason: 'statement_timeout',
            statusCode: 429,
            responseBody,
            requestId: req.id,
            ...searchInstanceMeta(),
          },
          'search classifier: throttled',
        );
        logger.warn({ durationMs, code }, 'search: statement timeout (mapped to 429)');
        return res.status(429).set('Retry-After', '3').json(responseBody);
      }
      if (isPoolSat || err?.statusCode === 503) {
        const responseBody = { error: 'Search temporarily busy; please retry.' };
        logger.warn(
          {
            search_alert_classification: true,
            classification: 'search_throttled',
            reason: 'pool_saturation',
            statusCode: 429,
            responseBody,
            requestId: req.id,
            ...searchInstanceMeta(),
          },
          'search classifier: throttled',
        );
        logger.warn(
          { durationMs, err: { name: err?.name, code: err?.code, message: err?.message } },
          'search: pool saturation (mapped to 429)',
        );
        return res.status(429).set('Retry-After', '2').json(responseBody);
      }
      logger.error({ err, durationMs }, 'search request failed');
      next(err);
    }
  });
};
