'use strict';

const { createTokenBucket } = require('../utils/inMemoryTokenBucket');
const { getAbuseLimitScale } = require('../utils/abuseKillSwitch');
const { apiRateLimitHitsTotal } = require('../utils/metrics');
const { getTrustedClientIp, isPrivateOrInternalNetwork } = require('../utils/trustedClientIp');
const { recordRateLimitStrike } = require('../utils/autoIpBan');

function noop(_req, _res, next) {
  next();
}

/**
 * Token-bucket limiter: per-user and per-IP (after authenticate for user id).
 */
function createUserIpTokenLimiter({
  name,
  userPerSecond,
  ipPerSecond,
  userBurst,
  ipBurst,
  userScopeLabel,
  ipScopeLabel,
} = {}) {
  if (process.env.DISABLE_RATE_LIMITS === 'true' || process.env.NODE_ENV === 'test') {
    return noop;
  }

  const userBucket = createTokenBucket({
    refillPerSecond: userPerSecond,
    burst: userBurst,
    getScale: getAbuseLimitScale,
  });
  const ipBucket = createTokenBucket({
    refillPerSecond: ipPerSecond,
    burst: ipBurst,
    getScale: getAbuseLimitScale,
  });

  return function userIpLimiter(req, res, next) {
    const ip = getTrustedClientIp(req);
    if (isPrivateOrInternalNetwork(ip)) return next();

    const uid = req.user?.id;
    if (uid && !userBucket.take(`u:${name}:${uid}`)) {
      apiRateLimitHitsTotal.inc({ scope: userScopeLabel });
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'Too many requests; slow down and retry shortly.' });
    }
    if (!ipBucket.take(`i:${name}:${ip}`)) {
      apiRateLimitHitsTotal.inc({ scope: ipScopeLabel });
      recordRateLimitStrike(ip);
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'Too many requests from this network.' });
    }
    next();
  };
}

const messagesHotPathLimiter = createUserIpTokenLimiter({
  name: 'messages',
  userPerSecond: 5,
  ipPerSecond: 10,
  userBurst: 10,
  ipBurst: 20,
  userScopeLabel: 'messages_inmem_user',
  ipScopeLabel: 'messages_inmem_ip',
});

const searchLimiter = createUserIpTokenLimiter({
  name: 'search',
  userPerSecond: 5,
  ipPerSecond: 10,
  userBurst: 10,
  ipBurst: 20,
  userScopeLabel: 'search_inmem_user',
  ipScopeLabel: 'search_inmem_ip',
});

module.exports = {
  createUserIpTokenLimiter,
  messagesHotPathLimiter,
  searchLimiter,
  /** @deprecated use getTrustedClientIp from ../utils/trustedClientIp */
  buildClientIp: getTrustedClientIp,
  getTrustedClientIp,
};
