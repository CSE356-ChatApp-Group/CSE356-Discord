/**
 * Community join rate-limiters.
 */

const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redis = require("../db/redis");
const { apiRateLimitHitsTotal } = require("../utils/metrics");
const { recordAbuseStrikeFromRequest } = require("../utils/autoIpBan");
const { parsePositiveIntEnv, clientIp, isInternalIp } = require("./common");

function communityJoinRateLimitNoop(_req, _res, next) {
  next();
}

function buildCommunityJoinIpRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "COMMUNITY_JOIN_PER_IP_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("COMMUNITY_JOIN_PER_IP_MAX", 300);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cji:${clientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:community_join:ip:",
    }),
    message: {
      error:
        "Too many community join requests from this network. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: "community_join_ip" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function buildCommunityJoinUserRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return communityJoinRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "COMMUNITY_JOIN_PER_USER_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("COMMUNITY_JOIN_PER_USER_MAX", 120);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isInternalIp(clientIp(req)),
    keyGenerator: (req) => `cju:${req.user?.id || "anon"}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:community_join:user:",
    }),
    message: {
      error:
        "Too many community join requests from this account. Slow down and try again shortly.",
    },
    handler: (_req, res, _next, options) => {
      apiRateLimitHitsTotal.inc({ scope: "community_join_user" });
      res.status(options.statusCode).json(options.message);
    },
  });
}

const communityJoinIpRateLimiter = buildCommunityJoinIpRateLimiter();
const communityJoinUserRateLimiter = buildCommunityJoinUserRateLimiter();

module.exports = {
  communityJoinRateLimitNoop,
  buildCommunityJoinIpRateLimiter,
  buildCommunityJoinUserRateLimiter,
  communityJoinIpRateLimiter,
  communityJoinUserRateLimiter,
};
