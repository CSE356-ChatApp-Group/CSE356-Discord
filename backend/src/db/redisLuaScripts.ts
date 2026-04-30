/**
 * Canonical Redis Lua script sources reused across modules.
 *
 * Keep these strings centralized so script id -> body mapping is auditable and
 * lock-release behavior stays identical across call sites.
 */

const LOCK_RELEASE_IF_MATCH_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

// Redis CAS: set KEYS[1] to ARGV[1] (ttl ARGV[2]) only if value changed/missing.
const PRESENCE_DB_CAS_LUA = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

module.exports = {
  LOCK_RELEASE_IF_MATCH_LUA,
  PRESENCE_DB_CAS_LUA,
};
