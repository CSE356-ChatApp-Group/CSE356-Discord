function envInt(name: string, defaultValue: number): number {
  const parsed = Number(process.env[name] ?? String(defaultValue));
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.floor(parsed);
}

const READ_STATE_FLUSH_INTERVAL_MS = envInt('READ_STATE_FLUSH_INTERVAL_MS', 10000);
const READ_STATE_FLUSH_BATCH_SIZE = Math.min(
  200,
  Math.max(25, envInt('READ_STATE_FLUSH_BATCH_SIZE', 100)),
);
const READ_STATE_FLUSH_SCAN_COUNT = Math.min(
  1000,
  Math.max(READ_STATE_FLUSH_BATCH_SIZE, envInt('READ_STATE_FLUSH_SCAN_COUNT', 200)),
);
const READ_STATE_FLUSH_LOCK_TTL_MS = Math.min(
  60000,
  Math.max(READ_STATE_FLUSH_INTERVAL_MS, envInt('READ_STATE_FLUSH_LOCK_TTL_MS', 30000)),
);
const READ_STATE_FLUSH_RETRY_MAX = Math.min(
  3,
  Math.max(0, envInt('READ_STATE_FLUSH_RETRY_MAX', 2)),
);

const batchReadStateConfig = Object.freeze({
  RS_DIRTY_SET: 'rs:dirty',
  RS_PENDING_KEY_PREFIX: 'rs:pending:',
  RS_FLUSH_LOCK_KEY: 'rs:flush:lock',
  RS_PENDING_TTL_SECS: 86400,
  READ_STATE_FLUSH_INTERVAL_MS,
  READ_STATE_FLUSH_BATCH_SIZE,
  READ_STATE_FLUSH_SCAN_COUNT,
  READ_STATE_FLUSH_LOCK_TTL_MS,
  READ_STATE_FLUSH_RETRY_MAX,
});

module.exports = { batchReadStateConfig };

