/**
 * Messages API router — mounts route modules under /api/v1/messages.
 *
 * Realtime fanout code lives under `fanout/`, pending replay under `pending/`,
 * read-state batching under `readState/`, and env defaults under `config/`
 * (including read-receipt tuning for PUT /messages/:id/read).
 *
 * Route map (implementation files in `routes/`):
 * - `get.ts`    — GET `/`, GET `/context/:messageId`
 * - `post.ts`   — POST `/`
 * - `patch.ts`  — PATCH `/:id`
 * - `delete.ts` — DELETE `/:id`
 * - `read.ts`   — PUT `/:id/read`, PUT `/batch-read`
 */


const express = require("express");
const { authenticate } = require("../middleware/authenticate");
const { messagesHotPathLimiter } = require("../middleware/inMemoryApiLimiter");

const registerGetRoutes = require("./routes/get");
const registerPostRoutes = require("./routes/post");
const registerPatchRoutes = require("./routes/patch");
const registerDeleteRoutes = require("./routes/delete");
const registerReadRoutes = require("./routes/read");

const router = express.Router();
router.use(authenticate);
router.use(messagesHotPathLimiter);

registerGetRoutes(router);
registerPostRoutes(router);
registerPatchRoutes(router);
registerDeleteRoutes(router);
registerReadRoutes(router);

module.exports = router;
