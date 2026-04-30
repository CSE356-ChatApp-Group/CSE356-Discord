/**
 * Auth API router — mounts route modules under /api/v1/auth.
 *
 * Shared logic: `shared.ts`
 * Route groups (`routes/`):
 * - `local.ts`       — register, login, refresh, logout, session
 * - `oauth.ts`       — OAuth pending completion, link intent, linked providers
 * - `oauthSocial.ts` — Google/GitHub Passport + course OIDC
 */

const express = require('express');

const registerLocalRoutes = require('./routes/local');
const registerOauthRoutes = require('./routes/oauth');
const registerOauthSocialRoutes = require('./routes/oauthSocial');

const router = express.Router();

registerLocalRoutes(router);
registerOauthRoutes(router);
registerOauthSocialRoutes(router);

module.exports = router;
