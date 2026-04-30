/**
 * Runtime log control (best-effort, non-blocking).
 *
 * Operators can toggle high-cost log categories at runtime via Redis keys:
 *   <prefix>:<category> = 1|true|on|enabled   -> force enabled
 *   <prefix>:<category> = 0|false|off|disabled -> force disabled
 *
 * Missing/invalid key => no override (use code/env default behavior).
 */

const redis = require("../db/redis");

const RUNTIME_LOG_CONTROL_ENABLED =
  String(process.env.RUNTIME_LOG_CONTROL_ENABLED || "false").toLowerCase() ===
  "true";
const RUNTIME_LOG_CONTROL_REFRESH_MS = Math.max(
  1000,
  Number.parseInt(process.env.RUNTIME_LOG_CONTROL_REFRESH_MS || "5000", 10) ||
    5000,
);
const RUNTIME_LOG_CONTROL_KEY_PREFIX =
  process.env.RUNTIME_LOG_CONTROL_KEY_PREFIX || "logctl";

const knownCategories = new Set();
const overrideByCategory = new Map();
let lastRefreshAtMs = 0;
let refreshingPromise = null;

function parseBoolLike(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "on", "enabled", "yes"].includes(v)) return true;
  if (["0", "false", "off", "disabled", "no"].includes(v)) return false;
  return null;
}

function categoryKey(category) {
  return `${RUNTIME_LOG_CONTROL_KEY_PREFIX}:${category}`;
}

function maybeRefreshOverrides() {
  if (!RUNTIME_LOG_CONTROL_ENABLED) return;
  const now = Date.now();
  if (now - lastRefreshAtMs < RUNTIME_LOG_CONTROL_REFRESH_MS) return;
  if (refreshingPromise) return;
  const categories = Array.from(knownCategories);
  if (!categories.length) return;

  lastRefreshAtMs = now;
  const keys = categories.map((c) => categoryKey(c));
  refreshingPromise = redis
    .mget(keys)
    .then((values) => {
      for (let i = 0; i < categories.length; i += 1) {
        const category = categories[i];
        const parsed = parseBoolLike(values?.[i]);
        if (parsed === null) {
          overrideByCategory.delete(category);
        } else {
          overrideByCategory.set(category, parsed);
        }
      }
    })
    .catch(() => {
      // Best-effort only: keep previous overrides/defaults.
    })
    .finally(() => {
      refreshingPromise = null;
    });
}

/**
 * Returns whether the category should log now.
 * - defaultEnabled: current code/env behavior when no runtime override exists.
 */
function isRuntimeLogCategoryEnabled(category, defaultEnabled = false) {
  if (!RUNTIME_LOG_CONTROL_ENABLED) return !!defaultEnabled;
  if (typeof category === "string" && category) {
    knownCategories.add(category);
  }
  maybeRefreshOverrides();
  const override = overrideByCategory.get(category);
  if (typeof override === "boolean") return override;
  return !!defaultEnabled;
}

module.exports = {
  isRuntimeLogCategoryEnabled,
};

