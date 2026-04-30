/**
 * Shared helpers for communities routes/services.
 */

const { validate: uuidValidate } = require("uuid");

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clientIp(req) {
  const realIp = req.headers["x-real-ip"];
  const firstRealIp = Array.isArray(realIp) ? realIp[0] : realIp;
  if (firstRealIp) return firstRealIp.trim();

  if (req.ip) return req.ip.trim();

  const forwardedFor = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;
  return (
    firstForwarded
      ? firstForwarded.split(",")[0]
      : req.socket?.remoteAddress || "unknown"
  ).trim();
}

function isInternalIp(ip) {
  const normalized = String(ip || "").replace(/^::ffff:/, "");
  const parts = normalized.split(".");
  const secondOctet = Number.parseInt(parts[1] || "", 10);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    ip === "::1" ||
    normalized.startsWith("10.") ||
    (parts[0] === "172" &&
      Number.isFinite(secondOctet) &&
      secondOctet >= 16 &&
      secondOctet <= 31) ||
    normalized.startsWith("192.168.")
  );
}

function parseCommunitiesPageQuery(req) {
  const rawL = req.query.limit;
  const rawA = req.query.after;
  let limit = null;
  if (rawL !== undefined && String(rawL).length) {
    const n = parseInt(String(rawL), 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return { error: "limit must be an integer from 1 to 100" };
    }
    limit = n;
  }
  let after = null;
  if (rawA !== undefined && String(rawA).length) {
    const s = String(rawA).trim();
    if (!uuidValidate(s)) return { error: "after must be a UUID" };
    after = s;
  }
  if (after && !limit) return { error: "after requires limit" };
  return { limit, after };
}

module.exports = {
  parsePositiveIntEnv,
  clientIp,
  isInternalIp,
  parseCommunitiesPageQuery,
};
