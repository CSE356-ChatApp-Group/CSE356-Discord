'use strict';

const { createTokenBucket } = require('../utils/inMemoryTokenBucket');
const { getAbuseLimitScale } = require('../utils/abuseKillSwitch');
const { wsUpgradeRateLimitedTotal, wsUpgradeSeenTotal } = require('../utils/metrics');
const { getTrustedClientIp, isPrivateOrInternalNetwork } = require('../utils/trustedClientIp');

const upgradeBucket = createTokenBucket({
  refillPerSecond: 1,
  burst: 2,
  getScale: getAbuseLimitScale,
});

function clientIpFromReq(req) {
  return getTrustedClientIp(req);
}

/**
 * @returns {boolean} true if upgrade may proceed
 */
function allowWsUpgrade(req) {
  wsUpgradeSeenTotal.inc();
  if (process.env.DISABLE_RATE_LIMITS === 'true' || process.env.NODE_ENV === 'test') {
    return true;
  }
  const ip = clientIpFromReq(req);
  if (isPrivateOrInternalNetwork(ip)) return true;
  if (!upgradeBucket.take(`wsup:${ip}`)) {
    wsUpgradeRateLimitedTotal.inc();
    return false;
  }
  return true;
}

module.exports = { allowWsUpgrade, clientIpFromReq };
