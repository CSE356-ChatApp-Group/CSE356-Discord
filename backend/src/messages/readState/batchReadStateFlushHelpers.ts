const { query } = require('../../db/pool');
const redis = require('../../db/redis');
const { readStateFlushRetriesTotal } = require('../../utils/metrics');
const {
  REDIS_LUA_IDS,
  registerRedisLuaScript,
  redisEvalSha,
} = require('../../db/redisLua');
const { LOCK_RELEASE_IF_MATCH_LUA } = require('../../db/redisLuaScripts');
const logger = require('../../utils/logger');
const {
  batchReadStateConfig: {
    RS_DIRTY_SET,
    RS_FLUSH_LOCK_KEY,
    READ_STATE_FLUSH_SCAN_COUNT,
    READ_STATE_FLUSH_LOCK_TTL_MS,
    READ_STATE_FLUSH_RETRY_MAX,
  },
} = require('../config/batchReadStateConfig');

let readStateFlushScanCursor = '0';
registerRedisLuaScript(REDIS_LUA_IDS.LOCK_RELEASE_IF_MATCH, LOCK_RELEASE_IF_MATCH_LUA);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushRetryDelayMs(attempt: number) {
  const base = 40 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 25);
  return Math.min(250, base + jitter);
}

function isRetryableFlushError(err: any) {
  const code = String(err?.code || '');
  const message = String(err?.message || '').toLowerCase();
  return (
    code === '40P01' ||
    code === '57014' ||
    message.includes('deadlock detected') ||
    message.includes('statement timeout')
  );
}

async function acquireFlushLock(): Promise<string | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  try {
    const acquired = await redis.set(
      RS_FLUSH_LOCK_KEY,
      token,
      'PX',
      READ_STATE_FLUSH_LOCK_TTL_MS,
      'NX',
    );
    return acquired === 'OK' ? token : null;
  } catch {
    return null;
  }
}

async function releaseFlushLock(token: string): Promise<void> {
  try {
    await redisEvalSha(redis, REDIS_LUA_IDS.LOCK_RELEASE_IF_MATCH, 1, RS_FLUSH_LOCK_KEY, token);
  } catch {
    // ignore
  }
}

async function runReadStateBatchUpsert(
  sql: string,
  params: [string[], (string | null)[], (string | null)[], string[], string[]],
) {
  for (let attempt = 0; attempt <= READ_STATE_FLUSH_RETRY_MAX; attempt += 1) {
    try {
      await query(sql, params);
      return;
    } catch (err: any) {
      if (attempt >= READ_STATE_FLUSH_RETRY_MAX || !isRetryableFlushError(err)) {
        throw err;
      }
      readStateFlushRetriesTotal.inc();
      logger.warn(
        { err, attempt: attempt + 1, retryMax: READ_STATE_FLUSH_RETRY_MAX },
        'read_state batch flush retryable query failure',
      );
      await sleep(flushRetryDelayMs(attempt + 1));
    }
  }
}

async function readDirtyKeysBatch(): Promise<string[]> {
  if (typeof redis.sscan === 'function') {
    const result = await redis.sscan(
      RS_DIRTY_SET,
      readStateFlushScanCursor,
      'COUNT',
      READ_STATE_FLUSH_SCAN_COUNT,
    );
    const nextCursor = Array.isArray(result) ? String(result[0] ?? '0') : '0';
    readStateFlushScanCursor = nextCursor;
    const keys = Array.isArray(result) ? result[1] : [];
    return Array.isArray(keys) ? keys : [];
  }
  return redis.smembers(RS_DIRTY_SET);
}

module.exports = {
  acquireFlushLock,
  releaseFlushLock,
  runReadStateBatchUpsert,
  readDirtyKeysBatch,
};

