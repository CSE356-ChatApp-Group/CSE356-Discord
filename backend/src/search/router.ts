/**
 * Search routes
 *
 * GET /api/v1/search?q=&channelId=&conversationId=&authorId=&after=&before=&limit=&offset=
 */

'use strict';

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const searchClient = require('./client');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { q, channelId, conversationId, authorId, after, before, limit, offset } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    // TODO: verify caller has access to channelId/conversationId before searching
    const results = await searchClient.search(q.trim(), {
      channelId, conversationId, authorId, after, before,
      limit:  parseInt(limit  || '20', 10),
      offset: parseInt(offset || '0',  10),
    });

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = router;
