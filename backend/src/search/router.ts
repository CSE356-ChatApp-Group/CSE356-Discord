/**
 * Search routes
 *
 * GET /api/v1/search?q=&channelId=&conversationId=&authorId=&after=&before=&limit=&offset=
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const searchClient = require('./client');
const overload = require('../utils/overload');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { q, channelId, conversationId, authorId, after, before, limit, offset } = req.query;
    if (overload.shouldRejectSearchRequests()) {
      return res.status(503).json({ error: 'Search temporarily unavailable under high load' });
    }

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    // TODO: verify caller has access to channelId/conversationId before searching
    const requestedLimit = parseInt(limit || '20', 10);
    const adjustedLimit = overload.searchLimit(requestedLimit);
    const results = await searchClient.search(q.trim(), {
      channelId, conversationId, authorId, after, before,
      limit: adjustedLimit,
      offset: parseInt(offset || '0',  10),
    });

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = router;
