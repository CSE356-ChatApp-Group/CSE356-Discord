/**
 * Redis-backed rate limiter for RUM POST /rum
 */

const { rateLimit } = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const redis = require("../db/redis");
const { getTrustedClientIp } = require("../utils/trustedClientIp");
const { recordAbuseStrikeFromRequest } = require("../utils/autoIpBan");
const { apiRateLimitHitsTotal } = require("../utils/metrics");

const rumPostLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: { ip?: string }) => `rum:${getTrustedClientIp(req) || "unknown"}`,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...args),
    prefix: "rl:rum:",
  }),
  message: { error: "Too many RUM reports. Please try again later." },
  handler: (req: any, res: any, _next: any, options: { statusCode: number; message?: unknown }) => {
    apiRateLimitHitsTotal.inc({ scope: "rum" });
    recordAbuseStrikeFromRequest(req);
    res.status(options.statusCode).json(options.message);
  },
});

function rumLimiterOrPassthrough() {
  if (process.env.DISABLE_RATE_LIMITS === "true") {
    return (_req: any, _res: any, next: any) => next();
  }
  return rumPostLimiter;
}

module.exports = { rumLimiterOrPassthrough };
