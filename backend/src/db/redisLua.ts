/**
 * Redis Lua execution via SCRIPT LOAD + EVALSHA.
 *
 * Why not inline EVAL every time? Redis parses and compiles Lua on each EVAL;
 * EVALSHA runs a preloaded digest and cuts bytes on the wire (important for
 * hot paths like PUT /messages/:id/read). On NOSCRIPT (flush, new server),
 * we reload once and retry.
 *
 * Conventions: pass all key names in KEYS[...] (hash tags for cluster if you
 * ever shard); use ARGV for values. See https://redis.io/docs/latest/develop/programmability/lua-api/
 */

type RedisWithScripts = {
  call: (...args: (string | number | Buffer)[]) => Promise<unknown>;
  evalsha: (sha: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
};

const scriptSourceById = new Map<string, string>();
const scriptShaById = new Map<string, string>();

/** Stable ids for SCRIPT LOAD / EVALSHA (wire string, not the digest). */
const REDIS_LUA_IDS = Object.freeze({
  READ_RECEIPT_CURSOR_ADVANCE: 'read_receipt_cursor_advance',
  READ_RECEIPT_RESET_UNREAD_WATERMARK: 'read_receipt_reset_unread_watermark',
});

function registerRedisLuaScript(id: string, source: string) {
  const body = String(source).trim();
  if (!body) {
    throw new Error(`empty Redis Lua script: ${id}`);
  }
  if (scriptSourceById.has(id)) {
    throw new Error(`duplicate Redis Lua script id: ${id}`);
  }
  scriptSourceById.set(id, body);
}

function isNoScriptError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return msg.includes('NOSCRIPT');
}

async function loadRedisLuaScript(redis: RedisWithScripts, id: string): Promise<string> {
  const body = scriptSourceById.get(id);
  if (!body) {
    throw new Error(`unknown Redis Lua script id: ${id}`);
  }
  const sha = String(await redis.call('SCRIPT', 'LOAD', body));
  scriptShaById.set(id, sha);
  return sha;
}

async function ensureRedisLuaSha(redis: RedisWithScripts, id: string): Promise<string> {
  const cached = scriptShaById.get(id);
  if (cached) {
    return cached;
  }
  return loadRedisLuaScript(redis, id);
}

async function redisEvalSha(
  redis: RedisWithScripts,
  id: string,
  numKeys: number,
  ...keysAndArgs: (string | number)[]
): Promise<unknown> {
  let sha = await ensureRedisLuaSha(redis, id);
  try {
    return await redis.evalsha(sha, numKeys, ...keysAndArgs);
  } catch (err) {
    if (!isNoScriptError(err)) {
      throw err;
    }
    scriptShaById.delete(id);
    sha = await loadRedisLuaScript(redis, id);
    return redis.evalsha(sha, numKeys, ...keysAndArgs);
  }
}

/** Load every registered script into the current Redis instance (call after PING). */
async function warmRedisLuaScripts(redis: RedisWithScripts) {
  const ids = [...scriptSourceById.keys()];
  if (!ids.length) {
    return;
  }
  await Promise.all(ids.map((id) => loadRedisLuaScript(redis, id)));
}

module.exports = {
  REDIS_LUA_IDS,
  registerRedisLuaScript,
  ensureRedisLuaSha,
  redisEvalSha,
  warmRedisLuaScripts,
};
