/**
 * Env-backed tunables and attachment policy for POST /messages.
 */


const BG_WRITE_POOL_GUARD = parseInt(
  process.env.BG_WRITE_POOL_GUARD || "5",
  10,
);

/** Shorter than role/PgBouncer caps so POST /messages fails fast on lock wait (hot channel + last_message UPDATE). */
const MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS || "5000",
    10,
  );
  if (!Number.isFinite(raw) || raw < 1000) return 5000;
  return Math.min(60000, raw);
})();

const MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS ||
      process.env.MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS ||
      "6500",
    10,
  );
  if (!Number.isFinite(raw) || raw < 1000) return 6500;
  return Math.min(60000, raw);
})();

/** Wall-clock cap for post-commit **message list cache bust** only (not fanout publish). */
const MESSAGE_POST_CACHE_BUST_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_CACHE_BUST_TIMEOUT_MS ||
      process.env.POST_INSERT_REDIS_WORK_TIMEOUT_MS ||
      "350",
    10,
  );
  if (!Number.isFinite(raw) || raw < 50) return 350;
  return Math.min(2000, raw);
})();

const MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS = (() => {
  const raw = parseInt(
    process.env.MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS || "125",
    10,
  );
  if (!Number.isFinite(raw) || raw < 25) return 125;
  return Math.min(1000, raw);
})();

const MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED = (() => {
  const raw = String(
    process.env.MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED || "false",
  ).toLowerCase();
  return raw === "1" || raw === "true";
})();

function messagePostAsyncFanoutEnabled() {
  const v = process.env.MESSAGE_POST_SYNC_FANOUT;
  return !(v === "1" || v === "true" || v === "yes");
}

const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_ATTACHMENTS_PER_MESSAGE = 4;

module.exports = {
  BG_WRITE_POOL_GUARD,
  MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS,
  MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS,
  MESSAGE_POST_CACHE_BUST_TIMEOUT_MS,
  MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS,
  MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED,
  messagePostAsyncFanoutEnabled,
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
};
