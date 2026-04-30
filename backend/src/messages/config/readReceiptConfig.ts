const _readReceiptDeferWaiting = parseInt(process.env.READ_RECEIPT_DEFER_POOL_WAITING || '8', 10);
const READ_RECEIPT_DEFER_POOL_WAITING =
  Number.isFinite(_readReceiptDeferWaiting) && _readReceiptDeferWaiting >= 0
    ? _readReceiptDeferWaiting
    : 8;

const READ_CURSOR_TS_TTL_SECS = parseInt(process.env.READ_CURSOR_TS_TTL_SECS || '600', 10);
const READ_DB_LOCK_TTL_MS = parseInt(process.env.READ_DB_LOCK_TTL_MS || '500', 10);
const READ_RECEIPT_CAS1_DEBOUNCE_MS = Math.min(
  1000,
  Math.max(500, parseInt(process.env.READ_RECEIPT_CAS1_DEBOUNCE_MS || '750', 10) || 750),
);
const READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS = 20000;
const READ_RECEIPT_SAME_MESSAGE_COALESCE_MS = Math.min(
  2000,
  Math.max(100, parseInt(process.env.READ_RECEIPT_SAME_MESSAGE_COALESCE_MS || '400', 10) || 400),
);
const READ_RECEIPT_RECENT_MAX_KEYS = 50000;
const READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS = Math.min(
  5000,
  Math.max(
    250,
    parseInt(process.env.READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS || '500', 10) || 500,
  ),
);
const READ_RECEIPT_SCOPE_DEBOUNCE_MS = Math.min(
  2000,
  Math.max(250, parseInt(process.env.READ_RECEIPT_SCOPE_DEBOUNCE_MS || '900', 10) || 900),
);
const READ_RECEIPT_FANOUT_ENABLED =
  String(process.env.READ_RECEIPT_FANOUT_ENABLED || 'true').toLowerCase() === 'true';
const READ_RECEIPT_CHANNEL_FANOUT_ASYNC = (() => {
  const raw = process.env.READ_RECEIPT_CHANNEL_FANOUT_ASYNC;
  if (raw === undefined || raw === '') return true;
  const v = String(raw).toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
})();
const READ_RECEIPT_SCOPE_CURSOR_MAX_KEYS = 75000;
const READ_RECEIPT_SCOPE_DEBOUNCE_MAX_KEYS = 75000;

const readReceiptConfig = Object.freeze({
  READ_RECEIPT_DEFER_POOL_WAITING,
  READ_CURSOR_TS_TTL_SECS,
  READ_DB_LOCK_TTL_MS,
  READ_RECEIPT_CAS1_DEBOUNCE_MS,
  READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS,
  READ_RECEIPT_SAME_MESSAGE_COALESCE_MS,
  READ_RECEIPT_RECENT_MAX_KEYS,
  READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS,
  READ_RECEIPT_SCOPE_DEBOUNCE_MS,
  READ_RECEIPT_FANOUT_ENABLED,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  READ_RECEIPT_SCOPE_CURSOR_MAX_KEYS,
  READ_RECEIPT_SCOPE_DEBOUNCE_MAX_KEYS,
});

module.exports = { readReceiptConfig };
