/**
 * POST /messages per-user and per-IP rate limiters (Redis-backed express-rate-limit).
 */


const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redis = require("../../db/redis");
const {
  getTrustedClientIp,
  isPrivateOrInternalNetwork,
} = require("../../utils/trustedClientIp");
const { recordAbuseStrikeFromRequest } = require("../../utils/autoIpBan");
const { messagePostRateLimitHitsTotal } = require("../../utils/metrics");

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messagePostRateLimitNoop(_req, _res, next) {
  next();
}

function buildMessagePostUserRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return messagePostRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv(
    "MESSAGE_POST_PER_USER_WINDOW_MS",
    60_000,
  );
  const limit = parsePositiveIntEnv("MESSAGE_POST_PER_USER_MAX", 90);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isPrivateOrInternalNetwork(getTrustedClientIp(req)),
    keyGenerator: (req) => `mpu:${req.user?.id || "anon"}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:mp:user:",
    }),
    message: {
      error:
        "Too many messages from this account. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      messagePostRateLimitHitsTotal.inc({ scope: "user" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function buildMessagePostIpRateLimiter() {
  if (
    process.env.DISABLE_RATE_LIMITS === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return messagePostRateLimitNoop;
  }
  const windowMs = parsePositiveIntEnv("MESSAGE_POST_PER_IP_WINDOW_MS", 60_000);
  const limit = parsePositiveIntEnv("MESSAGE_POST_PER_IP_MAX", 300);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => isPrivateOrInternalNetwork(getTrustedClientIp(req)),
    keyGenerator: (req) => `mpi:${getTrustedClientIp(req)}`,
    store: new RedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:mp:ip:",
    }),
    message: {
      error:
        "Too many messages from this network. Slow down and try again shortly.",
    },
    handler: (req, res, _next, options) => {
      messagePostRateLimitHitsTotal.inc({ scope: "ip" });
      recordAbuseStrikeFromRequest(req);
      res.status(options.statusCode).json(options.message);
    },
  });
}

function createMessagePostRateLimiters() {
  return {
    messagePostIpRateLimiter: buildMessagePostIpRateLimiter(),
    messagePostUserRateLimiter: buildMessagePostUserRateLimiter(),
  };
}

module.exports = {
  parsePositiveIntEnv,
  buildMessagePostUserRateLimiter,
  buildMessagePostIpRateLimiter,
  createMessagePostRateLimiters,
};
