/**
 * Env parsing and tunables for per-channel message insert locks.
 */

function parseIntEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseFloatEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseFloat(process.env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const MESSAGE_INSERT_LOCK_TTL_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_TTL_MS',
  45000,
  5000,
  120000,
);
const MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS',
  2000,
  500,
  4000,
);
const MESSAGE_INSERT_LOCK_POLL_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_POLL_MIN_MS',
  15,
  5,
  250,
);
const MESSAGE_INSERT_LOCK_POLL_MAX_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_POLL_MAX_MS',
  120,
  MESSAGE_INSERT_LOCK_POLL_MIN_MS,
  1000,
);
const MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL = parseIntEnv(
  'MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL',
  32,
  1,
  1000,
);
const MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE = parseFloatEnv(
  'MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE',
  0.02,
  0,
  1,
);
const MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS',
  250,
  1,
  60000,
);
/** When 1/true, log every sampled insert path at rate 1.0. */
const MESSAGE_INSERT_LOCK_PATH_LOG =
  String(process.env.MESSAGE_INSERT_LOCK_PATH_LOG || '').toLowerCase() === '1' ||
  process.env.MESSAGE_INSERT_LOCK_PATH_LOG === 'true' ||
  process.env.MESSAGE_INSERT_LOCK_PATH_LOG === 'yes';
const MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE = parseFloatEnv(
  'MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE',
  0,
  0,
  1,
);
const MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS',
  250,
  25,
  2000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS',
  2000,
  250,
  10000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS',
  200,
  0,
  2000,
);
const MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS = parseIntEnv(
  'MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS',
  500,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS,
  5000,
);

module.exports = {
  parseIntEnv,
  parseFloatEnv,
  MESSAGE_INSERT_LOCK_TTL_MS,
  MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS,
  MESSAGE_INSERT_LOCK_POLL_MIN_MS,
  MESSAGE_INSERT_LOCK_POLL_MAX_MS,
  MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL,
  MESSAGE_INSERT_LOCK_HOLDER_LOG_SAMPLE_RATE,
  MESSAGE_INSERT_LOCK_HOLDER_LOG_MIN_MS,
  MESSAGE_INSERT_LOCK_PATH_LOG,
  MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE,
  MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS,
  MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS,
};
