/**
 * Process-local + Redis-backed fleet visibility for read-receipt shedding after POST /messages
 * insert-phase DB timeouts. Preflight only reads memory updated by this module (sync path).
 */

const redis = require("../db/redis");
const {
  messageInsertUnhealthyRedisMarkTotal,
  readReceiptInsertUnhealthyPollTotal,
  readReceiptInsertUnhealthyGlobalCache,
} = require("../utils/metrics");

/** Fleet-wide signal; single key, TTL matches READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS. */
const MESSAGE_INSERT_UNHEALTHY_REDIS_KEY = "health:message_insert_unhealthy";

let unhealthyUntilMs = 0;

/** Worker-local cache: last polled global Redis health (updated by background poll only). */
let globalUnhealthyCached = false;

let pollTimer: NodeJS.Timeout | null = null;

function parseShedEnabled(): boolean {
  const v = process.env.READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED;
  if (v === undefined || v === "") return true;
  const s = String(v).toLowerCase();
  return s !== "false" && s !== "0" && s !== "no" && s !== "off";
}

function parseUnhealthyTtlMs(): number {
  const raw = parseInt(
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS || "10000",
    10,
  );
  if (!Number.isFinite(raw)) return 10000;
  return Math.min(120000, Math.max(1000, raw));
}

function parsePollMs(): number {
  const raw = parseInt(
    process.env.READ_RECEIPT_GLOBAL_INSERT_UNHEALTHY_POLL_MS || "500",
    10,
  );
  if (!Number.isFinite(raw)) return 500;
  return Math.min(1000, Math.max(250, raw));
}

function setGlobalCacheGauge(value: boolean): void {
  globalUnhealthyCached = value;
  readReceiptInsertUnhealthyGlobalCache.set(value ? 1 : 0);
}

/**
 * Redis GET failure is intentionally treated as healthy (fail-open): avoid fleet-wide
 * read defer when Redis is unavailable.
 */
async function pollGlobalInsertHealth(): Promise<void> {
  try {
    const v = await redis.get(MESSAGE_INSERT_UNHEALTHY_REDIS_KEY);
    const hit = v != null && v !== "";
    setGlobalCacheGauge(hit);
    readReceiptInsertUnhealthyPollTotal.inc({ result: hit ? "hit" : "miss" });
  } catch {
    setGlobalCacheGauge(false);
    readReceiptInsertUnhealthyPollTotal.inc({ result: "error" });
  }
}

function ensureGlobalHealthPoller(): void {
  if (!parseShedEnabled()) return;
  if (pollTimer !== null) return;
  const ms = parsePollMs();
  pollTimer = setInterval(() => {
    void pollGlobalInsertHealth();
  }, ms);
}

/** Called when POST /messages returns insert-phase statement/query timeout (503). */
function markMessageInsertUnhealthyForReadShedding(): void {
  if (!parseShedEnabled()) return;
  const now = Date.now();
  const ttl = parseUnhealthyTtlMs();
  unhealthyUntilMs = Math.max(unhealthyUntilMs, now + ttl);

  setGlobalCacheGauge(true);
  ensureGlobalHealthPoller();

  void redis
    .set(MESSAGE_INSERT_UNHEALTHY_REDIS_KEY, "1", "PX", ttl)
    .then(() => {
      messageInsertUnhealthyRedisMarkTotal.inc({ result: "ok" });
    })
    .catch(() => {
      messageInsertUnhealthyRedisMarkTotal.inc({ result: "error" });
    });
}

/** True while recent insert timeouts imply DB write path pressure (local or fleet-visible). */
function getShouldDeferReadReceiptForMessageInsertUnhealthy(): boolean {
  if (!parseShedEnabled()) return false;
  ensureGlobalHealthPoller();
  if (Date.now() < unhealthyUntilMs) return true;
  return globalUnhealthyCached;
}

function resetMessageInsertHealthForTests(): void {
  unhealthyUntilMs = 0;
  setGlobalCacheGauge(false);
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  MESSAGE_INSERT_UNHEALTHY_REDIS_KEY,
  markMessageInsertUnhealthyForReadShedding,
  getShouldDeferReadReceiptForMessageInsertUnhealthy,
  resetMessageInsertHealthForTests,
};
