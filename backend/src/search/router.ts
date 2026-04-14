/**
 * Search routes
 *
 * GET /api/v1/search?q=&communityId=&channelId=&conversationId=&authorId=&after=&before=&limit=&offset=
 *
 * Scope: communityId, channelId, and/or conversationId (see handler: when
 * channelId === conversationId, only conversation scope is used — matches
 * COMPAS generated client searchMessages URL).
 * Omitting all three falls back to an access-filtered cross-scope search.
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { query } = require('../db/pool');
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

    const normalizedQuery = String(q || '').trim();
    const hasFilterOnlySearch = Boolean(authorId || after || before);

    if (!normalizedQuery && !hasFilterOnlySearch) {
      return res.status(400).json({ error: 'Provide a query or at least one search filter' });
    }

    const userId = req.user.id;

    // Verify scope access before executing the search query.
    if (communityId) {
      // Caller must be a member of the community.
      const { rowCount } = await query(
        `SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2`,
        [communityId, userId],
      );
      if (!rowCount) return res.status(403).json({ error: 'Access denied' });
    } else if (channelId) {
      const { rowCount } = await query(
        `SELECT 1 FROM channels ch
         JOIN community_members community_member
           ON community_member.community_id = ch.community_id
          AND community_member.user_id = $1
         LEFT JOIN channel_members cm ON cm.channel_id = ch.id AND cm.user_id = $1
         WHERE ch.id = $2
           AND (ch.is_private = FALSE OR cm.user_id IS NOT NULL)`,
        [userId, channelId],
      );
      if (!rowCount) return res.status(403).json({ error: 'Access denied' });
    } else if (conversationId) {
      const { rowCount } = await query(
        `SELECT 1 FROM conversation_participants
         WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [conversationId, userId],
      );
      if (!rowCount) return res.status(403).json({ error: 'Access denied' });
    }

    const { limit: clampedLimit, offset: clampedOffset } = clampSearchPaging(limit, offset);
    const adjustedLimit = overload.searchLimit(clampedLimit);
    const results = await searchClient.search(normalizedQuery, {
      communityId, channelId, conversationId, authorId, after, before,
      userId,
      limit: adjustedLimit,
      offset: clampedOffset,
    });

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = router;
