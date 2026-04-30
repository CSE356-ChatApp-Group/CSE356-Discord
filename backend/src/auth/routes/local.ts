/**
 * Auth routes — local
 */
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const { query } = require('../../db/pool');
const { signAccess, verifyRefresh, denyToken } = require('../../utils/jwt');
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
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    res.json(S.issueTokens(res, user));
  })(req, res, next);
});

// ── Refresh ────────────────────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const token = req.cookies[S.REFRESH_COOKIE];
  if (!token) return res.status(401).json({ error: 'No refresh token' });
  try {
    const payload = verifyRefresh(token);
    const accessToken = signAccess({ id: payload.id, username: payload.username, email: payload.email });
    res.json({ accessToken });
  } catch {
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

router.get('/session', async (_req, res, next) => {
  try {
    if (!isAuthBypassEnabled()) {
      return res.json({ authBypass: false, accessToken: null, user: null });
    }

    const { user } = await getBypassAuthContext();
    res.json({
      accessToken: null,
      authBypass: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (err) {
    next(err);
  }
});
};
