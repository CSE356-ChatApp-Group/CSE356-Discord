/**
 * Process-local "message insert unhealthy" window after POST /messages insert-phase DB timeouts.
 * Extends a TTL on each qualifying failure so PUT /read can defer without extra DB work.
 */

let unhealthyUntilMs = 0;

function parseShedEnabled(): boolean {
  const v = process.env.READ_RECEIPT_SHED_ON_MESSAGE_INSERT_TIMEOUT_ENABLED;
  if (v === undefined || v === '') return true;
  const s = String(v).toLowerCase();
  return s !== 'false' && s !== '0' && s !== 'no' && s !== 'off';
}

function parseUnhealthyTtlMs(): number {
  const raw = parseInt(
    process.env.READ_RECEIPT_MESSAGE_INSERT_UNHEALTHY_TTL_MS || '10000',
    10,
  );
  if (!Number.isFinite(raw)) return 10000;
  return Math.min(120000, Math.max(1000, raw));
}

/** Called when POST /messages returns insert-phase statement/query timeout (503). */
function markMessageInsertUnhealthyForReadShedding(): void {
  if (!parseShedEnabled()) return;
  const now = Date.now();
  const ttl = parseUnhealthyTtlMs();
  unhealthyUntilMs = Math.max(unhealthyUntilMs, now + ttl);
}

/** True while recent insert timeouts imply DB write path pressure on this worker. */
function getShouldDeferReadReceiptForMessageInsertUnhealthy(): boolean {
  if (!parseShedEnabled()) return false;
  return Date.now() < unhealthyUntilMs;
}

function resetMessageInsertHealthForTests(): void {
  unhealthyUntilMs = 0;
}

module.exports = {
  markMessageInsertUnhealthyForReadShedding,
  getShouldDeferReadReceiptForMessageInsertUnhealthy,
  resetMessageInsertHealthForTests,
};
