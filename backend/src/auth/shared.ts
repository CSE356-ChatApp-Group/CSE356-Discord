/**
 * Shared auth helpers, rate limiters, and OAuth / OIDC plumbing.
 * Handlers live in `routes/*.ts`.
 */

const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const passport = require('passport');

const { query, getClient } = require('../db/pool');
const redis            = require('../db/redis');
const { signAccess, signRefresh } = require('../utils/jwt');
const { authRateLimitHitsTotal } = require('../utils/metrics');
const logger = require('../utils/logger');
const { signOAuthPending, signOAuthLinkIntent, verifyOAuthLinkIntent } = require('./oauthTokens');
const { getTrustedClientIp, isPrivateOrInternalNetwork } = require('../utils/trustedClientIp');
const { recordAbuseStrikeFromRequest } = require('../utils/autoIpBan');

const REFRESH_COOKIE = 'refreshToken';
const AUTH_USER_SELECT = 'id, username, email, display_name, avatar_url, updated_at';
const AUTH_USER_SELECT_WITH_PASSWORD = `${AUTH_USER_SELECT}, password_hash`;

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

function buildAuthKey(req, route) {
  const clientIp = getTrustedClientIp(req);
  const credential = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : typeof req.body?.username === 'string'
      ? req.body.username.trim().toLowerCase()
      : 'anonymous';
  return `${route}:${clientIp}:${credential}`;
}

function buildAuthIpKey(req, route) {
  return `${route}:${getTrustedClientIp(req)}`;
}

function getAuthRateLimitContext(req, route, scope = 'credential') {
  const trustedClientIp = getTrustedClientIp(req);
  const isInternal = isPrivateOrInternalNetwork(trustedClientIp);
  const limiterKey = scope === 'ip'
    ? buildAuthIpKey(req, route)
    : buildAuthKey(req, route);
  return { trustedClientIp, isInternal, limiterKey };
}

function shouldSkipAuthRateLimit(req) {
  return getAuthRateLimitContext(req, 'skip-check', 'ip').isInternal;
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
    skip: shouldSkipAuthRateLimit,
    keyGenerator: (req) => buildAuthKey(req, route),
    // Shared Redis store so the limit is consistent across all Node.js instances.
    // Falls back to the default in-memory store if Redis is unavailable.
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${route}:`,
    }),
    message: { error: 'Too many auth attempts. Please wait a minute and try again.' },
    handler: (req, res, _next, options) => {
      const { trustedClientIp, isInternal, limiterKey } = getAuthRateLimitContext(req, route, 'credential');
      logger.warn({
        requestId: req.id || req.requestId,
        route: req.originalUrl || req.path || req.url,
        trustedClientIp,
        isInternal,
        limiterKey,
        reason: 'auth_rate_limit_exceeded',
        scope: route,
      }, 'auth rate limiter blocked request');
      authRateLimitHitsTotal.inc({ route });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

/**
 * Per-client-IP cap across all credentials. Load harnesses often use a unique
 * username per virtual user; per-credential limits do not damp that stampede.
 *
 * @param {'global-flag'|'register-always'} gate
 *   - **global-flag** (login): active only when `AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`.
 *   - **register-always**: always active for `POST /register` (except test / disabled),
 *     because registration abuse uses a fresh username per request and bypasses
 *     the per-credential `registerLimiter` buckets.
 */
function buildAuthIpLimiter(
  route,
  { limit, windowMs, limitEnv, windowEnv },
  { gate = 'global-flag' } = {},
) {
  if (process.env.DISABLE_RATE_LIMITS === 'true') {
    return (_req, _res, next) => next();
  }
  if (gate === 'global-flag' && process.env.AUTH_GLOBAL_PER_IP_RATE_LIMIT !== 'true') {
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
    skip: shouldSkipAuthRateLimit,
    keyGenerator: (req) => buildAuthIpKey(req, route),
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: `rl:${route}-global-ip:`,
    }),
    message: { error: 'Too many auth attempts from this network. Please wait and try again.' },
    handler: (req, res, _next, options) => {
      const { trustedClientIp, isInternal, limiterKey } = getAuthRateLimitContext(req, route, 'ip');
      logger.warn({
        requestId: req.id || req.requestId,
        route: req.originalUrl || req.path || req.url,
        trustedClientIp,
        isInternal,
        limiterKey,
        reason: 'auth_rate_limit_exceeded',
        scope: route,
      }, 'auth rate limiter blocked request');
      authRateLimitHitsTotal.inc({ route });
      recordAbuseStrikeFromRequest(req);
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

const registerGlobalIpLimiter = buildAuthIpLimiter(
  'register_global_ip',
  {
    limit: 120,
    windowMs: 10 * 60 * 1000,
    limitEnv: 'AUTH_REGISTER_GLOBAL_PER_IP_MAX',
    windowEnv: 'AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS',
  },
  { gate: 'register-always' },
);

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

function decodeJwtPayloadWithoutVerify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function fastCourseOidcClaims(tokenBody) {
  const preferred = decodeJwtPayloadWithoutVerify(tokenBody?.id_token)
    || decodeJwtPayloadWithoutVerify(tokenBody?.access_token);
  if (!preferred || typeof preferred !== 'object') return null;
  const subject = typeof preferred.sub === 'string' ? preferred.sub : null;
  if (!subject) return null;
  return {
    sub: subject,
    email: typeof preferred.email === 'string' ? preferred.email : null,
    preferred_username:
      typeof preferred.preferred_username === 'string' ? preferred.preferred_username : null,
    name: typeof preferred.name === 'string' ? preferred.name : null,
  };
}

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
      `SELECT u.${AUTH_USER_SELECT.split(', ').join(', u.')}
         FROM users u
         JOIN oauth_accounts oa ON oa.user_id = u.id
        WHERE oa.provider=$1 AND oa.provider_id=$2`,
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

      const target = await client.query(
        `SELECT ${AUTH_USER_SELECT}
           FROM users
          WHERE id = $1 AND is_active = TRUE`,
        [payload.userId],
      );
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
        `SELECT u.${AUTH_USER_SELECT.split(', ').join(', u.')}
           FROM users u
           JOIN oauth_accounts oa ON oa.user_id = u.id
          WHERE oa.provider=$1 AND oa.provider_id=$2`,
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

module.exports = {
  REFRESH_COOKIE,
  AUTH_USER_SELECT,
  AUTH_USER_SELECT_WITH_PASSWORD,
  registerLimiter,
  loginLimiter,
  loginGlobalIpLimiter,
  registerGlobalIpLimiter,
  passwordConnectLimiter,
  issueTokens,
  getRefreshCookieClearOptions,
  buildFrontendUrl,
  startOAuth,
  oauthCallback,
  getCourseDiscovery,
  getCourseCallbackUrl,
  resolveOAuthAccount,
  COURSE_CLIENT_ID,
  COURSE_CLIENT_SECRET,
  isTransientOidcFetchFailure,
  fastCourseOidcClaims,
  signOAuthLinkIntent,
  verifyOAuthLinkIntent,
};
