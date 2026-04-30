/**
 * JWT helpers – sign and verify access tokens.
 *
 * Access tokens are short-lived (JWT_ACCESS_TTL, default 24h).
 * Refresh tokens are longer-lived (7 days) and stored as httpOnly cookies.
 * A deny-list in Redis handles logout before expiry.
 */


const crypto = require('crypto');
const jwt   = require('jsonwebtoken');
const redis = require('../db/redis');

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'change-me-access';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh';
const ACCESS_TTL     = process.env.JWT_ACCESS_TTL || '24h';
const REFRESH_TTL    = process.env.JWT_REFRESH_TTL || '7d';

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const ACCESS_VERIFY_CACHE_TTL_MS = parsePositiveInt(process.env.JWT_ACCESS_VERIFY_CACHE_TTL_MS, 15_000);
// Default matches ACCESS_VERIFY_CACHE_TTL_MS: logout explicitly calls clearTokenCaches(),
// so a longer TTL has no security impact while saving ~15x Redis round-trips under load.
const DENYLIST_CHECK_CACHE_TTL_MS = parsePositiveInt(process.env.JWT_DENYLIST_CHECK_CACHE_TTL_MS, 15_000);
const TOKEN_CACHE_MAX_ENTRIES = parsePositiveInt(process.env.JWT_TOKEN_CACHE_MAX_ENTRIES, 5_000);

const verifiedAccessCache = new Map();
const denylistCache = new Map();

function setCachedEntry(cache, token, entry) {
  if (cache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(token, entry);
}

function getCachedEntry(cache, token, now = Date.now()) {
  const entry = cache.get(token);
  if (!entry) return null;
  if (entry.expiresAtMs <= now || entry.cacheUntilMs <= now) {
    cache.delete(token);
    return null;
  }
  return entry;
}

function getTokenExpiryMs(token, fallbackMs = Date.now() + ACCESS_VERIFY_CACHE_TTL_MS) {
  const decoded = jwt.decode(token);
  return typeof decoded?.exp === 'number' ? decoded.exp * 1000 : fallbackMs;
}

function clearTokenCaches(token) {
  verifiedAccessCache.delete(token);
  denylistCache.delete(token);
}

function signAccess(payload) {
  // Ensure each access token is unique even for same user issued in same second.
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: ACCESS_TTL,
    jwtid: crypto.randomUUID(),
  });
}

function signRefresh(payload) {
  // Keep refresh tokens unique as well; avoids accidental token-string reuse.
  return jwt.sign(payload, REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
    jwtid: crypto.randomUUID(),
  });
}

function verifyAccess(token) {
  const now = Date.now();
  const cached = getCachedEntry(verifiedAccessCache, token, now);
  if (cached) {
    return cached.payload;
  }

  const payload = jwt.verify(token, ACCESS_SECRET);
  const expiresAtMs = typeof payload?.exp === 'number'
    ? payload.exp * 1000
    : now + ACCESS_VERIFY_CACHE_TTL_MS;

  setCachedEntry(verifiedAccessCache, token, {
    payload,
    expiresAtMs,
    cacheUntilMs: Math.min(expiresAtMs, now + ACCESS_VERIFY_CACHE_TTL_MS),
  });

  return payload;
}

function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

/** Blacklist a token until its natural expiry */
async function denyToken(token, expiresAt) {
  const expiresAtMs = expiresAt * 1000;
  const ttl = Math.ceil((expiresAtMs - Date.now()) / 1000);
  if (ttl > 0) {
    await redis.set(`deny:${token}`, '1', 'EX', ttl);
  }

  clearTokenCaches(token);
  setCachedEntry(denylistCache, token, {
    denied: true,
    expiresAtMs,
    cacheUntilMs: Math.min(expiresAtMs, Date.now() + DENYLIST_CHECK_CACHE_TTL_MS),
  });
}

async function isDenied(token) {
  const now = Date.now();
  const cached = getCachedEntry(denylistCache, token, now);
  if (cached) {
    return cached.denied;
  }

  let denied: boolean;
  try {
    denied = (await redis.exists(`deny:${token}`)) === 1;
  } catch (err) {
    // Redis unavailable: fail open rather than blocking all authenticated requests.
    // The in-process verify cache already validated the signature; this is a
    // brief availability trade-off during Redis downtime.
    const logger = require('./logger');
    logger.warn({ err }, 'jwt: Redis denylist check failed, failing open');
    return false;
  }
  const expiresAtMs = getTokenExpiryMs(token, now + DENYLIST_CHECK_CACHE_TTL_MS);
  setCachedEntry(denylistCache, token, {
    denied,
    expiresAtMs,
    cacheUntilMs: Math.min(expiresAtMs, now + DENYLIST_CHECK_CACHE_TTL_MS),
  });
  return denied;
}

async function authenticateAccessToken(token) {
  const payload = verifyAccess(token);
  if (await isDenied(token)) {
    const err = new Error('Token has been revoked');
    Object.assign(err, { code: 'TOKEN_REVOKED' });
    throw err;
  }
  return payload;
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, denyToken, isDenied, authenticateAccessToken };
