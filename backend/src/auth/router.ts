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
const { verifyOAuthPending, signOAuthPending, signOAuthLinkIntent, verifyOAuthLinkIntent } = require('./oauthTokens');

const router = express.Router();
const REFRESH_COOKIE = 'refreshToken';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (milliseconds)
};

function issueTokens(res, user) {
  const payload = { id: user.id, username: user.username, email: user.email };
  const accessToken  = signAccess(payload);
  const refreshToken = signRefresh(payload);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  return { accessToken, user: payload };
}

function buildFrontendUrl(path, query = {}) {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const target = base ? `${base}${path}` : path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${target}?${qs}` : target;
}

function startOAuth(provider, baseOptions = {}) {
  return (req, res, next) => {
    if (!passport._strategy(provider)) {
      return res.status(503).json({ error: `${provider} auth is not configured` });
    }
    const opts: any = { ...baseOptions, session: false };
    if (req.query?.linkToken) {
      opts.state = req.query.linkToken;
    }
    passport.authenticate(provider, opts)(req, res, next);
  };
}

function oauthCallback(provider) {
  return (req, res, next) => {
    passport.authenticate(provider, { session: false, failureRedirect: '/login?error=oauth' }, (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        return res.redirect(buildFrontendUrl('/login', { error: info?.message || 'oauth' }));
      }

      if (user.oauthPendingToken) {
        return res.redirect(buildFrontendUrl('/oauth-callback', { pending: user.oauthPendingToken, provider }));
      }

      const { accessToken } = issueTokens(res, user);
      return res.redirect(buildFrontendUrl('/oauth-callback', { token: accessToken, provider }));
    })(req, res, next);
  };
}

const COURSE_DISCOVERY_URL = process.env.COURSE_OIDC_DISCOVERY_URL
  || 'https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth/.well-known/openid-configuration';
const COURSE_CLIENT_ID = process.env.COURSE_OIDC_CLIENT_ID || 'web-service';
const COURSE_CLIENT_SECRET = process.env.COURSE_OIDC_CLIENT_SECRET || 'web-service-secret';
let courseDiscoveryCache;

async function getCourseDiscovery() {
  if (courseDiscoveryCache) return courseDiscoveryCache;
  const res = await fetch(COURSE_DISCOVERY_URL);
  if (!res.ok) {
    throw new Error(`Failed OIDC discovery (${res.status})`);
  }
  courseDiscoveryCache = await res.json();
  return courseDiscoveryCache;
}

function getCourseCallbackUrl(req) {
  if (process.env.COURSE_OIDC_CALLBACK_URL) return process.env.COURSE_OIDC_CALLBACK_URL;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/v1/auth/course/callback`;
}

async function resolveOAuthAccount(provider, providerId, email, displayName, linkToken) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
      [provider, providerId]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return { user: existing.rows[0] };
    }

    if (linkToken) {
      let payload;
      try {
        payload = verifyOAuthLinkIntent(linkToken);
      } catch {
        await client.query('ROLLBACK');
        return { error: 'Invalid link intent token' };
      }

      const target = await client.query('SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [payload.userId]);
      if (!target.rows.length) {
        await client.query('ROLLBACK');
        return { error: 'Link target account not found' };
      }

      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [target.rows[0].id, provider, providerId, email || null]
      );

      await client.query('COMMIT');
      return { user: target.rows[0] };
    }

    const pendingToken = signOAuthPending({
      provider,
      providerId,
      email: email || null,
      displayName: displayName || null,
    });

    await client.query('COMMIT');
    return { pendingToken };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      const linked = await client.query(
        'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
        [provider, providerId]
      );
      if (linked.rows.length) {
        return { user: linked.rows[0] };
      }
      return { error: 'OAuth account already linked' };
    }
    throw err;
  } finally {
    client.release();
  }
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

router.post('/oauth/complete-create',
  body('pendingToken').isString().isLength({ min: 20 }),
  body('username').optional().isAlphanumeric().isLength({ min: 3, max: 32 }),
  body('displayName').optional().isLength({ min: 1, max: 64 }),
  body('password').optional().isLength({ min: 8 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let pending;
    try {
      pending = verifyOAuthPending(req.body.pendingToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth continuation token' });
    }

    const email = pending.email || req.body.email;
    if (!email) {
      return res.status(400).json({ error: 'Email is required to create an account from OAuth sign-in' });
    }

    const generatedUsernameBase = (email.split('@')[0] || `${pending.provider}_user`)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 24)
      || `${pending.provider}user`;
    const username = req.body.username || `${generatedUsernameBase}${Date.now().toString().slice(-4)}`.slice(0, 32);
    const displayName = req.body.displayName || pending.displayName || username;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingProvider = await client.query(
        'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
        [pending.provider, pending.providerId]
      );
      if (existingProvider.rows.length) {
        await client.query('COMMIT');
        return res.json(issueTokens(res, existingProvider.rows[0]));
      }

      const emailTaken = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (emailTaken.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already exists. Use connect-existing flow.' });
      }

      const passwordHash = req.body.password ? await bcrypt.hash(req.body.password, 12) : null;
      const created = await client.query(
        `INSERT INTO users (email, username, display_name, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [email, username, displayName, passwordHash]
      );

      const user = created.rows[0];
      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [user.id, pending.provider, pending.providerId, email]
      );

      await client.query('COMMIT');
      return res.json(issueTokens(res, user));
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Could not complete account creation due to conflicting account data' });
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.post('/oauth/complete-connect',
  body('pendingToken').isString().isLength({ min: 20 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let pending;
    try {
      pending = verifyOAuthPending(req.body.pendingToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth continuation token' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingProvider = await client.query(
        'SELECT u.* FROM users u JOIN oauth_accounts oa ON oa.user_id = u.id WHERE oa.provider=$1 AND oa.provider_id=$2',
        [pending.provider, pending.providerId]
      );
      if (existingProvider.rows.length) {
        await client.query('COMMIT');
        return res.json(issueTokens(res, existingProvider.rows[0]));
      }

      const account = await client.query('SELECT * FROM users WHERE email=$1 AND is_active=TRUE', [req.body.email]);
      if (!account.rows.length) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid credentials for existing account' });
      }

      const user = account.rows[0];
      if (!user.password_hash) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Existing account has no password; set one first before connecting by credentials' });
      }

      const ok = await bcrypt.compare(req.body.password, user.password_hash);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid credentials for existing account' });
      }

      await client.query(
        'INSERT INTO oauth_accounts (user_id, provider, provider_id, email) VALUES ($1,$2,$3,$4)',
        [user.id, pending.provider, pending.providerId, pending.email || req.body.email]
      );

      await client.query('COMMIT');
      return res.json(issueTokens(res, user));
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'OAuth account is already linked to another user' });
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

router.post('/oauth/link-intent', authenticate,
  body('provider').isIn(['google', 'github', 'course']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const provider = req.body.provider;
    const linkToken = signOAuthLinkIntent({
      userId: req.user.id,
      provider,
      purpose: 'oauth-link',
    });

    const authUrl = `/api/v1/auth/${provider}?linkToken=${encodeURIComponent(linkToken)}`;
    return res.json({ provider, authUrl });
  }
);

// ── Google OAuth ───────────────────────────────────────────────────────────────
router.get('/google', startOAuth('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', oauthCallback('google'));

// ── GitHub OAuth ───────────────────────────────────────────────────────────────
router.get('/github', startOAuth('github'));

router.get('/github/callback', oauthCallback('github'));

// ── Course OIDC OAuth ──────────────────────────────────────────────────────────
router.get('/course', async (req, res, next) => {
  try {
    const discovery = await getCourseDiscovery();
    const callbackUrl = getCourseCallbackUrl(req);
    const linkToken = typeof req.query?.linkToken === 'string' ? req.query.linkToken : null;
    const state = signOAuthLinkIntent({
      purpose: 'course-login',
      linkToken,
      ts: Date.now(),
    });

    const params = new URLSearchParams({
      client_id: COURSE_CLIENT_ID,
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: callbackUrl,
      state,
    });

    res.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
  } catch (err) {
    next(err);
  }
});

router.get('/course/callback', async (req, res, next) => {
  try {
    const discovery = await getCourseDiscovery();
    const callbackUrl = getCourseCallbackUrl(req);
    const code = req.query?.code;
    const state = req.query?.state;

    if (!code || typeof code !== 'string') {
      return res.redirect(buildFrontendUrl('/login', { error: 'Missing OIDC authorization code' }));
    }

    let statePayload;
    try {
      statePayload = verifyOAuthLinkIntent(typeof state === 'string' ? state : '');
    } catch {
      return res.redirect(buildFrontendUrl('/login', { error: 'Invalid OIDC state' }));
    }

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: COURSE_CLIENT_ID,
        client_secret: COURSE_CLIENT_SECRET,
      }),
    });

    if (!tokenRes.ok) {
      return res.redirect(buildFrontendUrl('/login', { error: 'OIDC token exchange failed' }));
    }
    const tokenBody = await tokenRes.json();
    const accessToken = tokenBody.access_token;
    if (!accessToken) {
      return res.redirect(buildFrontendUrl('/login', { error: 'OIDC access token missing' }));
    }

    const userInfoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) {
      return res.redirect(buildFrontendUrl('/login', { error: 'OIDC userinfo fetch failed' }));
    }

    const userinfo = await userInfoRes.json();
    const providerId = userinfo.sub;
    const email = userinfo.email || null;
    const displayName = userinfo.name || userinfo.preferred_username || email || 'OIDC User';
    if (!providerId) {
      return res.redirect(buildFrontendUrl('/login', { error: 'OIDC subject missing' }));
    }

    const linkToken = statePayload?.linkToken || null;
    const outcome = await resolveOAuthAccount('course', providerId, email, displayName, linkToken);
    if (outcome.error) {
      return res.redirect(buildFrontendUrl('/login', { error: outcome.error }));
    }
    if (outcome.pendingToken) {
      return res.redirect(buildFrontendUrl('/oauth-callback', { pending: outcome.pendingToken, provider: 'course' }));
    }

    const tokens = issueTokens(res, outcome.user);
    return res.redirect(buildFrontendUrl('/oauth-callback', { token: tokens.accessToken, provider: 'course' }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
