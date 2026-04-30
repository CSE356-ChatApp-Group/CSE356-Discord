/**
 * Channels API router — mounts route modules under /api/v1/channels.
 *
 * Shared helpers: `channelRouterShared.ts`
 * Route map (`routes/`):
 * - `list.ts`    — GET `/`
 * - `create.ts` — POST `/`
 * - `members.ts` — GET|POST `/:id/members`
 * - `patch.ts`  — PATCH `/:id`
 * - `delete.ts` — DELETE `/:id`
 */

const express = require('express');
const { authenticate } = require('../middleware/authenticate');

const registerListRoutes = require('./routes/list');
const registerCreateRoutes = require('./routes/create');
const registerMembersRoutes = require('./routes/members');
const registerPatchRoutes = require('./routes/patch');
const registerDeleteRoutes = require('./routes/delete');

const router = express.Router();
router.use(authenticate);

registerListRoutes(router);
registerCreateRoutes(router);
registerMembersRoutes(router);
registerPatchRoutes(router);
registerDeleteRoutes(router);

module.exports = router;
