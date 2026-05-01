/**
 * Auth routes — local
 */
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const { query } = require('../../db/pool');
const { signAccess, verifyRefresh, denyToken, authenticateAccessToken } = require('../../utils/jwt');
const { authenticate } = require('../../middleware/authenticate');
const { hashPassword, comparePassword } = require('../passwords');
const { isAuthBypassEnabled, getBypassAuthContext } = require('../bypass');
const { verifyOAuthPending } = require('../oauthTokens');
const S = require('../shared');

module.exports = function register(router) {
router.post('/register',
  S.registerGlobalIpLimiter,
  S.registerLimiter,
  body('email').optional({ nullable: true, checkFalsy: true }).isString(),
  body('username').isString().custom((value) => value.trim().length > 0),
  body('password').isString(),
  body('displayName').optional().isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, username, password, displayName } = req.body;
      const normalizedUsername = typeof username === 'string' ? username.trim() : username;
      const normalizedEmail = typeof email === 'string' && email.trim().length ? email.trim() : null;
      const hash = await hashPassword(password, 'register_hash');
      const { rows } = await query(
        `INSERT INTO users (email, username, password_hash, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING
         RETURNING ${S.AUTH_USER_SELECT}`,
        [normalizedEmail, normalizedUsername, hash, displayName || normalizedUsername]
      );
      if (!rows.length) {
        return res.status(409).json({ error: 'Email or username already taken' });
      }
      res.status(201).json(S.issueTokens(res, rows[0]));
    } catch (err: any) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Email or username already taken' });
      }
      next(err);
    }
  }
);

// ── Local Login ────────────────────────────────────────────────────────────────
router.post('/login', S.loginGlobalIpLimiter, S.loginLimiter, (req, res, next) => {
  const loginMode = S.hadRecentRefreshFailure(req) ? 'after_refresh_failure' : 'fresh';
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err) {
      S.recordAuthSessionFlow('login', loginMode, 'error');
      return next(err);
    }
    if (!user) {
      S.recordAuthSessionFlow('login', loginMode, 'invalid_credentials');
      return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    }
    S.clearRecentRefreshFailure(res);
    S.recordAuthSessionFlow('login', loginMode, 'success');
    res.json(S.issueTokens(res, user));
  })(req, res, next);
});

// ── Refresh ────────────────────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const token = req.cookies[S.REFRESH_COOKIE];
  if (!token) {
    S.recordAuthSessionFlow('refresh', 'cookie', 'missing_token');
    return res.status(401).json({ error: 'No refresh token' });
  }
  try {
    const payload = verifyRefresh(token);
    const accessToken = signAccess({ id: payload.id, username: payload.username, email: payload.email });
    S.clearRecentRefreshFailure(res);
    S.recordAuthSessionFlow('refresh', 'cookie', 'success');
    res.json({ accessToken });
  } catch {
    S.markRecentRefreshFailure(res);
    S.recordAuthSessionFlow('refresh', 'cookie', 'invalid');
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    if (isAuthBypassEnabled() && !req.token) {
      res.clearCookie(S.REFRESH_COOKIE, S.getRefreshCookieClearOptions());
      return res.json({ message: 'Logged out (auth bypass)' });
    }

    // Decode the access token for its exp to set deny-list TTL
    const payload = req.user;
    await denyToken(req.token, payload.exp);
    res.clearCookie(S.REFRESH_COOKIE, S.getRefreshCookieClearOptions());
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

router.get('/session', async (req, res, next) => {
  try {
    const authHeader = typeof req.headers.authorization === 'string'
      ? req.headers.authorization
      : '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const refreshToken = req.cookies[S.REFRESH_COOKIE];

    if (isAuthBypassEnabled() && !bearerToken && !refreshToken) {
      const { user } = await getBypassAuthContext();
      S.recordAuthSessionFlow('session', 'bypass', 'success');
      return res.json({
        accessToken: null,
        authBypass: true,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
      });
    }

    let payload = null;
    let accessToken = null;
    let sessionMode = 'none';

    if (bearerToken) {
      try {
        payload = await authenticateAccessToken(bearerToken);
        accessToken = bearerToken;
        sessionMode = 'access_token';
      } catch {
        S.recordAuthSessionFlow('session', 'access_token', 'failure');
      }
    }

    if (!payload && refreshToken) {
      try {
        const refreshPayload = verifyRefresh(refreshToken);
        accessToken = signAccess({
          id: refreshPayload.id,
          username: refreshPayload.username,
          email: refreshPayload.email,
        });
        payload = refreshPayload;
        sessionMode = 'refresh_cookie';
        S.clearRecentRefreshFailure(res);
      } catch {
        S.recordAuthSessionFlow('session', 'refresh_cookie', 'failure');
      }
    }

    if (!payload?.id) {
      S.recordAuthSessionFlow('session', sessionMode, 'miss');
      return res.json({ authBypass: false, accessToken: null, user: null });
    }

    const { rows } = await query(
      `SELECT ${S.AUTH_USER_SELECT}
         FROM users
        WHERE id = $1
          AND is_active = TRUE`,
      [payload.id],
    );
    if (!rows.length) {
      S.recordAuthSessionFlow('session', sessionMode, 'miss');
      return res.json({ authBypass: false, accessToken: null, user: null });
    }

    S.recordAuthSessionFlow('session', sessionMode, 'success');
    res.json({
      accessToken,
      authBypass: false,
      user: S.serializeAuthUser(rows[0]),
    });
  } catch (err) {
    next(err);
  }
});
};
