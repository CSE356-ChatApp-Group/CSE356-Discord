'use strict';

/**
 * Redis-backed temporary IP ban after sustained rate-limit abuse.
 * External/public IPs only (same notion as trustedClientIp + isPrivateOrInternalNetwork).
 * Fails open if Redis errors. Disabled in test, when DISABLE_RATE_LIMITS, or AUTO_IP_BAN_ENABLED=false.
 */

const redis = require('../db/redis');
const logger = require('./logger');
const { getTrustedClientIp, isPrivateOrInternalNetwork } = require('./trustedClientIp');

function isFeatureEnabled() {
  const v = process.env.AUTO_IP_BAN_ENABLED;
  if (typeof v === 'string') {
    const n = v.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(n)) return false;
    if (['1', 'true', 'yes', 'on'].includes(n)) return true;
  }
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.DISABLE_RATE_LIMITS === 'true') return false;
  return process.env.NODE_ENV === 'production';
}

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function banRedisKey(ip) {
  return `abuse:ban:v1:${ip}`;
}

function strikeRedisKey(ip, windowSec) {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  return `abuse:stk:v1:${ip}:${bucket}`;
}

/**
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
async function isIpAutoBanned(ip) {
  if (!isFeatureEnabled()) return false;
  if (!ip || ip === 'unknown' || isPrivateOrInternalNetwork(ip)) return false;
  try {
    const v = await redis.get(banRedisKey(ip));
    return v === '1';
  } catch (err) {
    logger.warn({ err }, 'autoIpBan: isIpAutoBanned failed, fail open');
    return false;
  }
}

/**
 * Fire-and-forget: increment strike counter; may SET ban key with TTL.
 * @param {string} ip
 */
function recordRateLimitStrike(ip) {
  if (!isFeatureEnabled()) return;
  if (!ip || ip === 'unknown' || isPrivateOrInternalNetwork(ip)) return;
  void recordStrikeInternal(ip).catch((err) => {
    logger.warn({ err, ip }, 'autoIpBan: recordStrikeInternal rejected');
  });
}

/**
 * @param {import('express').Request} req
 */
function recordAbuseStrikeFromRequest(req) {
  try {
    recordRateLimitStrike(getTrustedClientIp(req));
  } catch {
    /* ignore */
  }
}

async function recordStrikeInternal(ip) {
  const strikesNeeded = parsePositiveIntEnv('AUTO_IP_BAN_STRIKES', 40);
  const windowSec = parsePositiveIntEnv('AUTO_IP_BAN_STRIKE_WINDOW_SEC', 120);
  const banTtlSec = parsePositiveIntEnv('AUTO_IP_BAN_TTL_SEC', 900);

  const sk = strikeRedisKey(ip, windowSec);
  try {
    const n = await redis.incr(sk);
    if (n === 1) {
      await redis.expire(sk, windowSec + 30);
    }
    if (n >= strikesNeeded) {
      await redis.set(banRedisKey(ip), '1', 'EX', banTtlSec);
      await redis.del(sk);
      const { abuseAutoBanIssuedTotal } = require('./metrics');
      abuseAutoBanIssuedTotal.inc();
      logger.warn({ ip, strikes: n, banTtlSec }, 'autoIpBan: IP temporarily banned after rate-limit abuse');
    }
  } catch (err) {
    logger.warn({ err, ip }, 'autoIpBan: recordStrikeInternal failed');
  }
}

module.exports = {
  isFeatureEnabled,
  isIpAutoBanned,
  recordRateLimitStrike,
  recordAbuseStrikeFromRequest,
};
