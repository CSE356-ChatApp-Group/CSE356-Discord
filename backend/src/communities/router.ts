/**
 * Communities API router — mounts route modules under /api/v1/communities.
 *
 * Shared logic: `communityShared.ts` (join path guard runs before `authenticate`).
 * Route map (`routes/`):
 * - `list.ts`    — GET `/`
 * - `create.ts` — POST `/`
 * - `getOne.ts` — GET `/:id`
 * - `delete.ts` — DELETE `/:id`
 * - `join.ts`   — POST `/join`, POST `/:id/join`
 * - `leave.ts`  — DELETE `/:id/leave`
 * - `members.ts` — GET `/:id/members`, PATCH `/:id/members/:userId`
 */

const express = require('express');
const { authenticate } = require('../middleware/authenticate');

const C = require('./communityShared');
const registerListRoutes = require('./routes/list');
const registerCreateRoutes = require('./routes/create');
const registerGetOneRoutes = require('./routes/getOne');
const registerDeleteRoutes = require('./routes/delete');
const registerJoinRoutes = require('./routes/join');
const registerLeaveRoutes = require('./routes/leave');
const registerMembersRoutes = require('./routes/members');

const router = express.Router();
C.registerJoinPathGuard(router);
router.use(authenticate);

registerListRoutes(router);
registerCreateRoutes(router);
registerGetOneRoutes(router);
registerDeleteRoutes(router);
registerJoinRoutes(router);
registerLeaveRoutes(router);
registerMembersRoutes(router);

module.exports = router;
