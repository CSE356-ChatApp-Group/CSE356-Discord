/**
 * Presence API — mounts route modules under /api/v1/presence.
 *
 * - `routes/bulkGet.ts` — GET `/`
 * - `routes/putStatus.ts` — PUT `/`
 */

const express = require("express");
const { authenticate } = require("../middleware/authenticate");
const { createUserIpTokenLimiter } = require("../middleware/inMemoryApiLimiter");

const registerPresenceGetRoute = require("./routes/bulkGet");
const registerPresencePutRoute = require("./routes/putStatus");

const presenceLimiter = createUserIpTokenLimiter({
  name: "presence",
  userPerSecond: 10,
  ipPerSecond: 30,
  userBurst: 20,
  ipBurst: 60,
  userScopeLabel: "presence_inmem_user",
  ipScopeLabel: "presence_inmem_ip",
});

const router = express.Router();
router.use(authenticate);
router.use(presenceLimiter);

registerPresenceGetRoute(router);
registerPresencePutRoute(router);

module.exports = router;
