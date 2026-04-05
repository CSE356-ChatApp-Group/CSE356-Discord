/**
 * Search routes
 *
 * GET /api/v1/search?q=&communityId=&channelId=&conversationId=&authorId=&after=&before=&limit=&offset=
 *
 * Exactly one scope param is expected: communityId, channelId, or conversationId.
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

router.get('/', async (req, res, next) => {
  try {
    const { q, communityId, channelId, conversationId, authorId, after, before, limit, offset } = req.query;
    if (overload.shouldRejectSearchRequests()) {
      return res.status(503).json({ error: 'Search temporarily unavailable under high load' });
    }

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
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

    const requestedLimit = parseInt(limit || '20', 10);
    const adjustedLimit = overload.searchLimit(requestedLimit);
    const results = await searchClient.search(q.trim(), {
      communityId, channelId, conversationId, authorId, after, before,
      userId,
      limit: adjustedLimit,
      offset: parseInt(offset || '0', 10),
    });

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = router;
