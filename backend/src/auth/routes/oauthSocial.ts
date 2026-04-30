/**
 * Passport Google/GitHub and course OIDC entry/callback routes.
 */
const S = require('../shared');

module.exports = function register(router) {
// ── Google OAuth ───────────────────────────────────────────────────────────────
router.get('/google', S.startOAuth('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', S.oauthCallback('google'));

// ── GitHub OAuth ───────────────────────────────────────────────────────────────
router.get('/github', S.startOAuth('github'));

router.get('/github/callback', S.oauthCallback('github'));

// ── Course OIDC OAuth ──────────────────────────────────────────────────────────
router.get('/course', async (req, res, next) => {
  try {
    const discovery = await S.getCourseDiscovery();
    const callbackUrl = S.getCourseCallbackUrl(req);
    const linkToken = typeof req.query?.linkToken === 'string' ? req.query.linkToken : null;
    const state = S.signOAuthLinkIntent({
      purpose: 'course-login',
      linkToken,
      ts: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: S.COURSE_CLIENT_ID,
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: callbackUrl,
      state,
    });

    res.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
  } catch (err) {
    if (S.isTransientOidcFetchFailure(err)) {
      return res.status(503).json({ error: 'Course OIDC is temporarily unavailable' });
    }
    next(err);
  }
});

router.get('/course/callback', async (req, res, next) => {
  try {
    const discovery = await S.getCourseDiscovery();
    const callbackUrl = S.getCourseCallbackUrl(req);
    const code = req.query?.code;
    const state = req.query?.state;

    if (!code || typeof code !== 'string') {
      return res.redirect(S.buildFrontendUrl('/login', { error: 'Missing OIDC authorization code' }));
    }

    let statePayload;
    try {
      statePayload = S.verifyOAuthLinkIntent(typeof state === 'string' ? state : '');
    } catch {
      return res.redirect(S.buildFrontendUrl('/login', { error: 'Invalid OIDC state' }));
    }

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: S.COURSE_CLIENT_ID,
        client_secret: S.COURSE_CLIENT_SECRET,
      }),
    });

    if (!tokenRes.ok) {
      return res.redirect(S.buildFrontendUrl('/login', { error: 'OIDC token exchange failed' }));
    }
    const tokenBody = await tokenRes.json();
    const accessToken = tokenBody.access_token;
    if (!accessToken) {
      return res.redirect(S.buildFrontendUrl('/login', { error: 'OIDC access token missing' }));
    }

    let userinfo = S.fastCourseOidcClaims(tokenBody);
    if (!userinfo) {
      const userInfoRes = await fetch(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userInfoRes.ok) {
        return res.redirect(S.buildFrontendUrl('/login', { error: 'OIDC userinfo fetch failed' }));
      }
      userinfo = await userInfoRes.json();
    }
    const providerId = userinfo.sub;
    const email = userinfo.email || null;
    const kcUsername = userinfo.preferred_username || null;
    const displayName = userinfo.name || kcUsername || email || 'OIDC User';
    if (!providerId) {
      return res.redirect(S.buildFrontendUrl('/login', { error: 'OIDC subject missing' }));
    }

    const linkToken = statePayload?.linkToken || null;
    const outcome = await S.resolveOAuthAccount('course', providerId, email, displayName, linkToken, kcUsername);
    if (outcome.error) {
      return res.redirect(S.buildFrontendUrl('/login', { error: outcome.error }));
    }
    if (outcome.pendingToken) {
      return res.redirect(S.buildFrontendUrl('/oauth-callback', { pending: outcome.pendingToken, provider: 'course' }));
    }

    const tokens = S.issueTokens(res, outcome.user);
    return res.redirect(S.buildFrontendUrl('/oauth-callback', { token: tokens.accessToken, provider: 'course' }));
  } catch (err) {
    next(err);
  }
});
};
