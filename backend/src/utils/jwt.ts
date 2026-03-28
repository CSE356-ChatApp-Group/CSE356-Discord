/**
 * JWT helpers – sign and verify access tokens.
 *
 * Access tokens are short-lived (15 min default).
 * Refresh tokens are longer-lived (7 days) and stored as httpOnly cookies.
 * A deny-list in Redis handles logout before expiry.
 */

'use strict';

const jwt   = require('jsonwebtoken');
const redis = require('../db/redis');

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'change-me-access';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh';
const ACCESS_TTL     = '15m';
const REFRESH_TTL    = '7d';

function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
}

function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

/** Blacklist a token until its natural expiry */
async function denyToken(token, expiresAt) {
  const ttl = Math.ceil((expiresAt * 1000 - Date.now()) / 1000);
  if (ttl > 0) {
    await redis.set(`deny:${token}`, '1', 'EX', ttl);
  }
}

async function isDenied(token) {
  return (await redis.exists(`deny:${token}`)) === 1;
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, denyToken, isDenied };
