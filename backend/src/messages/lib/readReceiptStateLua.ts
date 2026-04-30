/**
 * Redis Lua for read-cursor CAS + pending read-state enqueue, and unread watermark copy.
 * See readReceiptState.ts for call sites.
 *
 * Four-key script:
 *   KEYS[1] = cursor key (read_cursor_ts:...)
 *   KEYS[2] = db_lock key (read_db_lock:...)
 *   KEYS[3] = pending read-state hash key (rs:pending:...)
 *   KEYS[4] = dirty set key (rs:dirty)
 *   ARGV[1] = new timestamp ms, ARGV[2] = cursor TTL secs, ARGV[3] = db_lock TTL ms
 *   ARGV[4] = dirty member, ARGV[5] = message id, ARGV[6] = message created_at
 *   ARGV[7] = channel id, ARGV[8] = conversation id, ARGV[9] = pending TTL secs
 * Returns 0: cursor already at/ahead — skip entirely.
 *         1: cursor advanced, but DB write rate-limited by lock — skip DB.
 *         2: cursor advanced AND dirty read-state payload enqueued.
 */
const READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA = `
local current = redis.call('GET', KEYS[1])
local new_ts = tonumber(ARGV[1])
if current and tonumber(current) >= new_ts then
  return 0
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
  redis.call('SADD', KEYS[4], ARGV[4])
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
