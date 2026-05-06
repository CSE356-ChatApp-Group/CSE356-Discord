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
  call?: (...args: (string | number | Buffer)[]) => Promise<unknown>;
  evalsha?: (sha: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  eval?: (script: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
};
const {
  redisLuaScriptLoadTotal,
  redisLuaEvalTotal,
  redisLuaNoScriptRetryTotal,
} = require('../utils/metrics');

const scriptSourceById = new Map<string, string>();
const scriptShaById = new Map<string, string>();

/** Stable ids for SCRIPT LOAD / EVALSHA (wire string, not the digest). */
const REDIS_LUA_IDS = Object.freeze({
  READ_RECEIPT_CURSOR_ADVANCE: 'read_receipt_cursor_advance',
  READ_RECEIPT_RESET_UNREAD_WATERMARK: 'read_receipt_reset_unread_watermark',
  LOCK_RELEASE_IF_MATCH: 'lock_release_if_match',
  PRESENCE_DB_CAS: 'presence_db_cas',
});

function registerRedisLuaScript(id: string, source: string) {
  const body = String(source).trim();
  if (!body) {
    throw new Error(`empty Redis Lua script: ${id}`);
  }
  const existing = scriptSourceById.get(id);
  if (existing != null) {
    if (existing === body) return;
    throw new Error(`duplicate Redis Lua script id: ${id}`);
  }
  scriptSourceById.set(id, body);
}

function isNoScriptError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return msg.includes('NOSCRIPT');
}

function metricSafeInc(metric: { inc: (...args: any[]) => void }, labels: Record<string, string>) {
  try {
    metric.inc(labels);
  } catch {
    // Metrics are best-effort; never break script execution paths.
  }
}

async function loadRedisLuaScript(redis: RedisWithScripts, id: string): Promise<string> {
  if (typeof redis.call !== 'function') {
    metricSafeInc(redisLuaScriptLoadTotal, { script_id: id, result: 'error' });
    throw new Error(`Redis SCRIPT LOAD unavailable for script: ${id}`);
  }
  const body = scriptSourceById.get(id);
  if (!body) {
    metricSafeInc(redisLuaScriptLoadTotal, { script_id: id, result: 'error' });
    throw new Error(`unknown Redis Lua script id: ${id}`);
  }
  let sha: string;
  try {
    // In cluster mode, SCRIPT LOAD must reach every master node — otherwise
    // EVALSHA hits NOSCRIPT on nodes that haven't loaded the script.
    // ioredis Cluster exposes nodes('master') returning per-node clients.
    const masterNodes: RedisWithScripts[] =
      typeof (redis as any).nodes === 'function'
        ? (redis as any).nodes('master')
        : [];
    if (masterNodes.length > 0) {
      const shas = await Promise.all(
        masterNodes.map((node) => node.call!('SCRIPT', 'LOAD', body)),
      );
      sha = String(shas[0]);
    } else {
      sha = String(await redis.call('SCRIPT', 'LOAD', body));
    }
  } catch (err) {
    metricSafeInc(redisLuaScriptLoadTotal, { script_id: id, result: 'error' });
    throw err;
  }
  metricSafeInc(redisLuaScriptLoadTotal, { script_id: id, result: 'ok' });
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
  if (typeof redis.evalsha !== 'function' || typeof redis.call !== 'function') {
    const body = scriptSourceById.get(id);
    if (!body || typeof redis.eval !== 'function') {
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'eval_fallback', result: 'error' });
      throw new Error(`Redis Lua fallback unavailable for script: ${id}`);
    }
    try {
      const result = await redis.eval(body, numKeys, ...keysAndArgs);
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'eval_fallback', result: 'ok' });
      return result;
    } catch (err) {
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'eval_fallback', result: 'error' });
      throw err;
    }
  }
  let sha = await ensureRedisLuaSha(redis, id);
  try {
    const result = await redis.evalsha(sha, numKeys, ...keysAndArgs);
    metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'evalsha', result: 'ok' });
    return result;
  } catch (err) {
    if (!isNoScriptError(err)) {
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'evalsha', result: 'error' });
      throw err;
    }
    metricSafeInc(redisLuaNoScriptRetryTotal, { script_id: id });
    scriptShaById.delete(id);
    sha = await loadRedisLuaScript(redis, id);
    try {
      const retried = await redis.evalsha(sha, numKeys, ...keysAndArgs);
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'evalsha', result: 'ok' });
      return retried;
    } catch (retryErr) {
      metricSafeInc(redisLuaEvalTotal, { script_id: id, mode: 'evalsha', result: 'error' });
      throw retryErr;
    }
  }
}

/** Load every registered script into the current Redis instance (call after PING). */
async function warmRedisLuaScripts(redis: RedisWithScripts) {
  if (typeof redis.call !== 'function') return;
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
