/**
 * Redis Lua for read-cursor CAS + pending read-state enqueue, and unread watermark copy.
 * See readReceiptState.ts for call sites.
 *
 * Three-key script (was four — rs:dirty removed for cluster compatibility):
 *   KEYS[1] = cursor key  (read_cursor_ts:...)
 *   KEYS[2] = db_lock key (read_db_lock:...)
 *   KEYS[3] = pending read-state hash key (rs:pending:...)
 *
 * All three keys use the same hash tag so they land on the same cluster slot.
 * The caller does SADD rs:dirty separately after a result of 2; the slight
 * non-atomicity is acceptable because rs:dirty is a delivery hint, not source
 * of truth — the batch flush also has a reconciliation scan.
 *
 *   ARGV[1] = new timestamp ms, ARGV[2] = cursor TTL secs, ARGV[3] = db_lock TTL ms
 *   ARGV[4] = (unused, kept for call-site compat), ARGV[5] = message id
 *   ARGV[6] = message created_at, ARGV[7] = channel id, ARGV[8] = conversation id
 *   ARGV[9] = pending TTL secs
 *
 * Returns {0, current}: cursor already at/ahead — skip entirely.
 *         1: cursor advanced, DB write rate-limited by lock — skip DB.
 *         2: cursor advanced AND pending read-state payload written to KEYS[3].
 */
const READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA = `
local current = redis.call('GET', KEYS[1])
local new_ts = tonumber(ARGV[1])
if current and tonumber(current) >= new_ts then
  return {0, current}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
local locked = redis.call('SET', KEYS[2], '1', 'NX', 'PX', tonumber(ARGV[3]))
if locked then
  redis.call(
    'HSET',
    KEYS[3],
    'msg_id', ARGV[5],
    'msg_created_at', ARGV[6],
    'channel_id', ARGV[7],
    'conversation_id', ARGV[8]
  )
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[9]))
  return 2
end
return 1
`;

const RESET_UNREAD_WATERMARK_LUA = `
local current = redis.call('GET', KEYS[1])
if current then
  redis.call('SET', KEYS[2], current, 'EX', tonumber(ARGV[1]))
  return 1
end
return 0
`;

module.exports = {
  READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA,
  RESET_UNREAD_WATERMARK_LUA,
};
