/**
 * Search API router — mounts route modules under /api/v1/search.
 *
 * Route map (`routes/`):
 * - `get.ts` — GET `/`
 */

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { searchLimiter } = require('../middleware/inMemoryApiLimiter');

const registerGetRoutes = require('./routes/get');

const router = express.Router();
router.use(authenticate);
router.use(searchLimiter);

registerGetRoutes(router);

module.exports = router;
