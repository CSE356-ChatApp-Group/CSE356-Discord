/**
 * Auth routes
 *
 * POST /api/v1/auth/register        – local registration
 * POST /api/v1/auth/login           – local login
 * POST /api/v1/auth/refresh         – exchange refresh token for new access token
 * POST /api/v1/auth/logout          – revoke tokens
 * GET  /api/v1/auth/google          – start Google OAuth
 * GET  /api/v1/auth/google/callback
 * GET  /api/v1/auth/github          – start GitHub OAuth
 * GET  /api/v1/auth/github/callback
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcrypt');
const passport = require('passport');
const { body, validationResult } = require('express-validator');

const { pool }         = require('../db/pool');
const { signAccess, signRefresh, verifyRefresh, denyToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/authenticate');
const { isAuthBypassEnabled, getBypassAuthContext } = require('./bypass');

const router = express.Router();
const REFRESH_COOKIE = 'refreshToken';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days ms
};

function issueTokens(res, user) {
  const payload = { id: user.id, username: user.username, email: user.email };
  const accessToken  = signAccess(payload);
  const refreshToken = signRefresh(payload);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  return { accessToken, user: payload };
}

// ── Register ───────────────────────────────────────────────────────────────────
router.post('/register',
  body('email').isEmail().normalizeEmail(),
  body('username').isAlphanumeric().isLength({ min: 3, max: 32 }),
  body('password').isLength({ min: 8 }),
  body('displayName').optional().isLength({ max: 64 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, username, password, displayName } = req.body;
      const hash = await bcrypt.hash(password, 12);
      const { rows } = await pool.query(
        `INSERT INTO users (email, username, password_hash, display_name)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [email, username, hash, displayName || username]
      );
      res.status(201).json(issueTokens(res, rows[0]));
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Email or username already taken' });
      }
      next(err);
    }
  }
);

// ── Local Login ────────────────────────────────────────────────────────────────
router.post('/login', (req, res, next) => {
  passport.authenticate('local', { session: false }, (err, user, info) => {
    if (err)   return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    res.json(issueTokens(res, user));
  })(req, res, next);
});

// ── Refresh ────────────────────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const token = req.cookies[REFRESH_COOKIE];
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
      res.clearCookie(REFRESH_COOKIE);
      return res.json({ message: 'Logged out (auth bypass)' });
    }

    // Decode the access token for its exp to set deny-list TTL
    const payload = req.user;
    await denyToken(req.token, payload.exp);
    res.clearCookie(REFRESH_COOKIE);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

router.get('/session', async (_req, res, next) => {
  try {
    if (!isAuthBypassEnabled()) {
      return res.status(404).json({ error: 'Not found' });
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

// ── Google OAuth ───────────────────────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { session: false, scope: ['profile', 'email'] }));

router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=oauth' }),
  (req, res) => {
    const { accessToken } = issueTokens(res, req.user);
    // Redirect to frontend with access token as query param (or set in cookie)
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/oauth-callback?token=${accessToken}`);
  }
);

// ── GitHub OAuth ───────────────────────────────────────────────────────────────
router.get('/github', passport.authenticate('github', { session: false }));

router.get('/github/callback',
  passport.authenticate('github', { session: false, failureRedirect: '/login?error=oauth' }),
  (req, res) => {
    const { accessToken } = issueTokens(res, req.user);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/oauth-callback?token=${accessToken}`);
  }
);

module.exports = router;
