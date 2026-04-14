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
const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const passport = require('passport');
const { body, validationResult } = require('express-validator');

const { query, getClient } = require('../db/pool');
const redis            = require('../db/redis');
const { signAccess, signRefresh, verifyRefresh, denyToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/authenticate');
const { authRateLimitHitsTotal } = require('../utils/metrics');
const { hashPassword, comparePassword } = require('./passwords');
const { isAuthBypassEnabled, getBypassAuthContext } = require('./bypass');
const { verifyOAuthPending, signOAuthPending, signOAuthLinkIntent, verifyOAuthLinkIntent } = require('./oauthTokens');

const router = express.Router();
const REFRESH_COOKIE = 'refreshToken';

function parseBooleanEnv(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parsePositiveIntEnv(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldUseSecureCookies() {
  const explicit = parseBooleanEnv(process.env.COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const frontendUrl = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || '';
  if (frontendUrl) {
    return frontendUrl.startsWith('https://');
  }

  return process.env.NODE_ENV === 'production';
}

function getRefreshCookieOptions() {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (milliseconds)
  };
}

function getRefreshCookieClearOptions() {
  const { maxAge, ...clearOptions } = getRefreshCookieOptions();
  return clearOptions;
}

function serializeAuthUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || null,
    displayName: user.display_name ?? user.displayName ?? user.username,
    avatarUrl: user.avatar_url ?? user.avatarUrl ?? null,
    updatedAt: user.updated_at ?? user.updatedAt ?? null,
  };
}

function issueTokens(res, user) {
  const payload = { id: user.id, username: user.username, email: user.email };
  const accessToken  = signAccess(payload);
  const refreshToken = signRefresh(payload);
  res.cookie(REFRESH_COOKIE, refreshToken, getRefreshCookieOptions());
  return { accessToken, user: serializeAuthUser(user) };
}

function buildClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return (firstForwarded ? firstForwarded.split(',')[0] : req.ip || req.socket?.remoteAddress || 'unknown').trim();
}

function buildAuthKey(req, route) {
  const clientIp = buildClientIp(req);
  const credential = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : typeof req.body?.username === 'string'
      ? req.body.username.trim().toLowerCase()
      : 'anonymous';
  return `${route}:${clientIp}:${credential}`;
}

function buildAuthLimiter(route, { limit, windowMs, limitEnv, windowEnv }) {
  if (process.env.DISABLE_RATE_LIMITS === 'true') {
    return (_req, _res, next) => next();
  }
  return rateLimit({
    windowMs: parsePositiveIntEnv(process.env[windowEnv], windowMs),
    limit: parsePositiveIntEnv(process.env[limitEnv], limit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => buildAuthKey(req, route),
    // Shared Redis store so the limit is consistent across all Node.js instances.
    // Falls back to the default in-memory store if Redis is unavailable.
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${route}:`,
    }),
    message: { error: 'Too many auth attempts. Please wait a minute and try again.' },
    handler: (_req, res, _next, options) => {
      authRateLimitHitsTotal.inc({ route });
      res.status(options.statusCode).json(options.message);
    },
  });
}

/**
 * Per-client-IP cap across all credentials. Load harnesses often use a unique
 * username per virtual user; per-credential limits do not damp that stampede.
 *
 * **Off by default** — returning 429 under burst is a product policy choice.
 * Set `AUTH_GLOBAL_PER_IP_RATE_LIMIT=true` to enable when you prefer shedding
 * overload over longer tails / nginx 504s.
 */
function buildAuthIpLimiter(route, { limit, windowMs, limitEnv, windowEnv }) {
  if (process.env.DISABLE_RATE_LIMITS === 'true') {
    return (_req, _res, next) => next();
  }
  if (process.env.AUTH_GLOBAL_PER_IP_RATE_LIMIT !== 'true') {
    return (_req, _res, next) => next();
  }
  // Jest creates hundreds of distinct users from one synthetic client IP; keep per-credential limits only.
  if (process.env.NODE_ENV === 'test') {
    return (_req, _res, next) => next();
  }
  return rateLimit({
    windowMs: parsePositiveIntEnv(process.env[windowEnv], windowMs),
    limit: parsePositiveIntEnv(process.env[limitEnv], limit),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `${route}:${buildClientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${route}-global-ip:`,
    }),
    message: { error: 'Too many auth attempts from this network. Please wait and try again.' },
    handler: (_req, res, _next, options) => {
      authRateLimitHitsTotal.inc({ route });
      res.status(options.statusCode).json(options.message);
    },
  });
}

const registerLimiter = buildAuthLimiter('register', {
  limit: 20,
  windowMs: 10 * 60 * 1000,
  limitEnv: 'AUTH_REGISTER_RATE_LIMIT_MAX',
  windowEnv: 'AUTH_REGISTER_RATE_LIMIT_WINDOW_MS',
});

const loginLimiter = buildAuthLimiter('login', {
  limit: 60,
  windowMs: 60 * 1000,
  limitEnv: 'AUTH_LOGIN_RATE_LIMIT_MAX',
  windowEnv: 'AUTH_LOGIN_RATE_LIMIT_WINDOW_MS',
});

const loginGlobalIpLimiter = buildAuthIpLimiter('login_global_ip', {
  limit: 480,
  windowMs: 60 * 1000,
  limitEnv: 'AUTH_LOGIN_GLOBAL_PER_IP_MAX',
  windowEnv: 'AUTH_LOGIN_GLOBAL_PER_IP_WINDOW_MS',
});

const registerGlobalIpLimiter = buildAuthIpLimiter('register_global_ip', {
  limit: 120,
  windowMs: 10 * 60 * 1000,
  limitEnv: 'AUTH_REGISTER_GLOBAL_PER_IP_MAX',
  windowEnv: 'AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS',
});

const passwordConnectLimiter = buildAuthLimiter('oauth-connect', {
  limit: 30,
  windowMs: 5 * 60 * 1000,
  limitEnv: 'AUTH_CONNECT_RATE_LIMIT_MAX',
  windowEnv: 'AUTH_CONNECT_RATE_LIMIT_WINDOW_MS',
});

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

function isTransientOidcFetchFailure(err) {
  return Boolean(
    err
    && typeof err === 'object'
    && (
      err.code === 'ECONNREFUSED'
      || err.code === 'ENOTFOUND'
      || err.code === 'EHOSTUNREACH'
      || err.code === 'ECONNRESET'
      || err.code === 'ETIMEDOUT'
      || err.code === 'UND_ERR_CONNECT_TIMEOUT'
      || err.code === 'UND_ERR_SOCKET'
      || err.name === 'TypeError'
    )
  );
}

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

async function resolveOAuthAccount(provider, providerId, email, displayName, linkToken, preferredUsername?) {
  const client = await getClient();
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

    // All first-time OAuth sign-ins (including course OIDC) use the pending flow so users
    // explicitly choose create-new vs connect-existing with credentials.

    const pendingToken = signOAuthPending({
      provider,
      providerId,
      email: email || null,
      displayName: displayName || null,
      preferredUsername: preferredUsername || null,
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
      const detail = typeof err.detail === 'string' ? err.detail : '';
      if (/users_username_key|users_email/i.test(detail) || err.constraint === 'users_username_key' || err.constraint === 'users_email_key') {
        return { error: 'Username or email already in use' };
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
  registerGlobalIpLimiter,
  registerLimiter,
  body('email').optional({ nullable: true, checkFalsy: true }).isString(),
  body('username').isString().custom((value) => value.trim().length > 0),
  body('password').isString(),
  body('displayName').optional().isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, username, password, displayName } = req.body;
      const normalizedEmail = typeof email === 'string' && email.trim().length ? email.trim() : null;
      const hash = await hashPassword(password, 'register_hash');
      const { rows } = await query(
        `INSERT INTO users (email, username, password_hash, display_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [normalizedEmail, username, hash, displayName || username]
      );
      if (!rows.length) {
        return res.status(409).json({ error: 'Email or username already taken' });
      }
      res.status(201).json(issueTokens(res, rows[0]));
    } catch (err: any) {
      if (err && err.code === '23505') {
        return res.status(409).json({ error: 'Email or username already taken' });
      }
      next(err);
    }
  }
);

// ── Local Login ────────────────────────────────────────────────────────────────
router.post('/login', loginGlobalIpLimiter, loginLimiter, (req, res, next) => {
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
      res.clearCookie(REFRESH_COOKIE, getRefreshCookieClearOptions());
      return res.json({ message: 'Logged out (auth bypass)' });
    }

    // Decode the access token for its exp to set deny-list TTL
    const payload = req.user;
    await denyToken(req.token, payload.exp);
    res.clearCookie(REFRESH_COOKIE, getRefreshCookieClearOptions());
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

router.post('/oauth/complete-create',
  registerGlobalIpLimiter,
  registerLimiter,
  body('pendingToken').isString().custom((value) => value.trim().length > 0),
  body('username').optional().isString(),
  body('displayName').optional().isString(),
  body('password').optional().isString(),
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

    const generatedUsernameBase = (email.split('@')[0] || `${pending.provider}_user`).trim()
      || `${pending.provider}user`;

    const preferredUsername = typeof pending.preferredUsername === 'string' && pending.preferredUsername.trim()
      ? pending.preferredUsername.trim()
      : typeof req.body.username === 'string' && req.body.username.trim()
        ? req.body.username.trim()
        : null;
    const username = preferredUsername || `${generatedUsernameBase}-${Date.now().toString().slice(-4)}`;
    const displayName = req.body.displayName || pending.displayName || username;

    let client;
    try {
      client = await getClient();
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

      const passwordHash = req.body.password ? await hashPassword(req.body.password, 'oauth_create_hash') : null;
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
      await client?.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Could not complete account creation due to conflicting account data' });
      }
      return next(err);
    } finally {
      client?.release();
    }
  }
);

router.post('/oauth/complete-connect',
  passwordConnectLimiter,
  body('pendingToken').isString().custom((value) => value.trim().length > 0),
  body('email').isString().custom((value) => value.trim().length > 0),
  body('password').isString(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let pending;
    try {
      pending = verifyOAuthPending(req.body.pendingToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired OAuth continuation token' });
    }

    let client;
    try {
      client = await getClient();
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

      const ok = await comparePassword(req.body.password, user.password_hash, 'oauth_connect_compare');
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
      await client?.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'OAuth account is already linked to another user' });
      }
      return next(err);
    } finally {
      client?.release();
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

router.get('/oauth/linked', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT provider FROM oauth_accounts WHERE user_id = $1 ORDER BY provider ASC',
      [req.user.id]
    );
    const passwordRow = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    return res.json({
      providers: rows.map(r => r.provider),
      hasPassword: Boolean(passwordRow.rows[0]?.password_hash),
    });
  } catch (err) {
    return next(err);
  }
});

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
    if (isTransientOidcFetchFailure(err)) {
      return res.status(503).json({ error: 'Course OIDC is temporarily unavailable' });
    }
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
    const kcUsername = userinfo.preferred_username || null;
    const displayName = userinfo.name || kcUsername || email || 'OIDC User';
    if (!providerId) {
      return res.redirect(buildFrontendUrl('/login', { error: 'OIDC subject missing' }));
    }

    const linkToken = statePayload?.linkToken || null;
    const outcome = await resolveOAuthAccount('course', providerId, email, displayName, linkToken, kcUsername);
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
