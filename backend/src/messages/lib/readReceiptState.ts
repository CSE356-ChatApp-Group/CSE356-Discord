/**
 * Read-receipt Redis CAS cursor, in-memory coalescing, and Lua used by PUT /messages/:id/read.
 * Tunables are frozen in `config/readReceiptConfig.ts`.
 */


const redis = require("../../db/redis");
const {
  registerRedisLuaScript,
  REDIS_LUA_IDS,
  redisEvalSha,
} = require("../../db/redisLua");
const { readReceiptCursorCacheHitTotal } = require("../../utils/metrics");
const { batchReadStateRedisKeys } = require("../readState/batchReadState");
const { readReceiptConfig } = require("../config/readReceiptConfig");
const {
  READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA,
  RESET_UNREAD_WATERMARK_LUA,
} = require("./readReceiptStateLua");

const {
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
  READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  READ_RECEIPT_SCOPE_CURSOR_MAX_KEYS,
  READ_RECEIPT_SCOPE_DEBOUNCE_MAX_KEYS,
} = readReceiptConfig;

// Read cursor Redis CAS: stores last-known cursor timestamp (epoch ms) per (user, target).
// The Lua script atomically advances only if the new value is strictly greater, preventing
// concurrent workers from double-writing the same row and serializing on PG row locks.
// After a Redis CAS win, the DB write is fired async (non-blocking) so PUT /read response
// time is Redis-bound (~1ms) rather than DB-bound (~10ms).
// TTL: 10 minutes — long enough to cover the grader session, short enough to GC old users.
const readReceiptCas1DebounceByTarget = new Map();
const readReceiptRecentByMessage = new Map();
const readReceiptScopeCursorByTarget = new Map();
const readReceiptScopeDebounceByTarget = new Map();

function readCursorTsKey(userId: string, channelId: string | null, conversationId: string | null) {
  if (channelId) return `read_cursor_ts:${userId}:ch:${channelId}`;
  if (conversationId) return `read_cursor_ts:${userId}:cv:${conversationId}`;
  throw new Error("read cursor scope required");
}

function readDbLockKey(userId: string, channelId: string | null, conversationId: string | null) {
  if (channelId) return `read_db_lock:${userId}:ch:${channelId}`;
  if (conversationId) return `read_db_lock:${userId}:cv:${conversationId}`;
  throw new Error("read db lock scope required");
}

function shouldRunCas1SideEffects(
  userId: string,
  channelId: string | null,
  conversationId: string | null,
) {
  const targetKey = channelId
    ? `${userId}:ch:${channelId}`
    : `${userId}:cv:${conversationId}`;
  const now = Date.now();
  const prev = Number(readReceiptCas1DebounceByTarget.get(targetKey) || 0);
  if (now - prev < READ_RECEIPT_CAS1_DEBOUNCE_MS) {
    return false;
  }
  readReceiptCas1DebounceByTarget.set(targetKey, now);
  if (readReceiptCas1DebounceByTarget.size > READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS) {
    let pruned = 0;
    for (const [k, ts] of readReceiptCas1DebounceByTarget) {
      if (now - Number(ts || 0) > READ_RECEIPT_CAS1_DEBOUNCE_MS * 8) {
        readReceiptCas1DebounceByTarget.delete(k);
        pruned += 1;
      }
      if (pruned >= 500) break;
    }
  }
  return true;
}

function shouldCoalesceSameMessageRead(userId: string, messageId: string) {
  const now = Date.now();
  const key = `${userId}:${messageId}`;
  const prev = Number(readReceiptRecentByMessage.get(key) || 0);
  if (prev > 0 && now - prev < READ_RECEIPT_SAME_MESSAGE_COALESCE_MS) {
    return true;
  }
  readReceiptRecentByMessage.set(key, now);
  if (readReceiptRecentByMessage.size > READ_RECEIPT_RECENT_MAX_KEYS) {
    let pruned = 0;
    for (const [k, ts] of readReceiptRecentByMessage) {
      if (now - Number(ts || 0) > READ_RECEIPT_SAME_MESSAGE_COALESCE_MS * 10) {
        readReceiptRecentByMessage.delete(k);
        pruned += 1;
      }
      if (pruned >= 1000) break;
    }
  }
  return false;
}

function hasConfirmedRecentMessageRead(userId: string, messageId: string) {
  const now = Date.now();
  const key = `${userId}:${messageId}`;
  const prev = Number(readReceiptRecentByMessage.get(key) || 0);
  if (prev > 0 && now - prev < READ_RECEIPT_SAME_MESSAGE_COALESCE_MS) {
    return true;
  }
  return false;
}

function rememberConfirmedMessageRead(userId: string, messageId: string) {
  const now = Date.now();
  const key = `${userId}:${messageId}`;
  readReceiptRecentByMessage.set(key, now);
  if (readReceiptRecentByMessage.size > READ_RECEIPT_RECENT_MAX_KEYS) {
    let pruned = 0;
    for (const [k, ts] of readReceiptRecentByMessage) {
      if (now - Number(ts || 0) > READ_RECEIPT_SAME_MESSAGE_COALESCE_MS * 10) {
        readReceiptRecentByMessage.delete(k);
        pruned += 1;
      }
      if (pruned >= 1000) break;
    }
  }
}

function readReceiptScopeCursorKey(
  userId: string,
  channelId: string | null,
  conversationId: string | null,
) {
  return channelId
    ? `${userId}:ch:${channelId}`
    : `${userId}:cv:${conversationId}`;
}

function readReceiptScopeCursorCacheSaysNoAdvance({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
  messageTsMs,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
}) {
  const now = Date.now();
  const key = readReceiptScopeCursorKey(userId, channelId, conversationId);
  const row = readReceiptScopeCursorByTarget.get(key);
  if (!row) {
    readReceiptCursorCacheHitTotal.inc({ result: "miss" });
    return false;
  }
  const { tsMs, seenAtMs } = row || {};
  if (
    !Number.isFinite(tsMs)
    || !Number.isFinite(seenAtMs)
    || now - seenAtMs > READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS
  ) {
    readReceiptScopeCursorByTarget.delete(key);
    readReceiptCursorCacheHitTotal.inc({ result: "miss" });
    return false;
  }
  const normalizedMsgTsMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  const noAdvance = Number.isFinite(normalizedMsgTsMs) && tsMs >= normalizedMsgTsMs;
  readReceiptCursorCacheHitTotal.inc({ result: noAdvance ? "hit" : "miss" });
  return noAdvance;
}

async function readReceiptScopeCursorHintSaysNoAdvance({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
  messageTsMs,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
}) {
  if (
    readReceiptScopeCursorCacheSaysNoAdvance({
      userId,
      channelId,
      conversationId,
      messageCreatedAt,
      messageTsMs,
    })
  ) {
    return true;
  }

  const normalizedMsgTsMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  if (!Number.isFinite(normalizedMsgTsMs)) {
    return false;
  }

  try {
    const raw = await redis.get(readCursorTsKey(userId, channelId, conversationId));
    if (raw == null) return false;
    const redisCursorTsMs = Number(raw);
    if (!Number.isFinite(redisCursorTsMs) || redisCursorTsMs < normalizedMsgTsMs) {
      return false;
    }
    rememberReadReceiptScopeCursor({
      userId,
      channelId,
      conversationId,
      messageCreatedAt: new Date(redisCursorTsMs).toISOString(),
      messageTsMs: redisCursorTsMs,
    });
    return true;
  } catch {
    return false;
  }
}

function rememberReadReceiptScopeCursor({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
  messageTsMs,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
}) {
  const key = readReceiptScopeCursorKey(userId, channelId, conversationId);
  const msgTsMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  if (!Number.isFinite(msgTsMs)) return;
  const prev = readReceiptScopeCursorByTarget.get(key);
  const prevTsMs = Number(prev?.tsMs || 0);
  readReceiptScopeCursorByTarget.set(key, {
    tsMs: Math.max(prevTsMs, msgTsMs),
    seenAtMs: Date.now(),
  });
  if (readReceiptScopeCursorByTarget.size > READ_RECEIPT_SCOPE_CURSOR_MAX_KEYS) {
    let pruned = 0;
    const now = Date.now();
    for (const [k, row] of readReceiptScopeCursorByTarget) {
      if (
        !row
        || !Number.isFinite(row.seenAtMs)
        || now - row.seenAtMs > READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS * 8
      ) {
        readReceiptScopeCursorByTarget.delete(k);
        pruned += 1;
      }
      if (pruned >= 1500) break;
    }
  }
}

function shouldCoalesceScopeBurstRead({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
  messageTsMs,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
}) {
  const key = readReceiptScopeCursorKey(userId, channelId, conversationId);
  const now = Date.now();
  const msgTsMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  if (!Number.isFinite(msgTsMs)) return false;
  const row = readReceiptScopeDebounceByTarget.get(key);
  if (
    row
    && Number.isFinite(row.untilMs)
    && Number.isFinite(row.maxTsMs)
    && now < row.untilMs
    && msgTsMs <= row.maxTsMs
  ) {
    return true;
  }
  const nextMax = row && Number.isFinite(row.maxTsMs)
    ? Math.max(row.maxTsMs, msgTsMs)
    : msgTsMs;
  readReceiptScopeDebounceByTarget.set(key, {
    maxTsMs: nextMax,
    untilMs: now + READ_RECEIPT_SCOPE_DEBOUNCE_MS,
    seenAtMs: now,
  });
  if (readReceiptScopeDebounceByTarget.size > READ_RECEIPT_SCOPE_DEBOUNCE_MAX_KEYS) {
    let pruned = 0;
    for (const [k, v] of readReceiptScopeDebounceByTarget) {
      if (
        !v
        || !Number.isFinite(v.seenAtMs)
        || now - v.seenAtMs > READ_RECEIPT_SCOPE_DEBOUNCE_MS * 8
      ) {
        readReceiptScopeDebounceByTarget.delete(k);
        pruned += 1;
      }
      if (pruned >= 1500) break;
    }
  }
  return false;
}

async function advanceReadStateCursor({
  userId,
  channelId,
  conversationId,
  messageId,
  messageCreatedAt,
  messageTsMs,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageId: string;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
}) {
  // Redis CAS gate: atomically advance the cursor timestamp in Redis only if
  // messageCreatedAt is strictly greater than the stored value. If Redis says
  // the cursor is already at/ahead of this position, skip the DB write entirely
  // — the DB's ON CONFLICT WHERE clause would reject it anyway, but we save the
  // round-trip (~10ms) and the row-level lock contention (seen as 14s max wait
  // when 5 workers target the same (user, channel) row simultaneously).
  //
  // If Redis CAS wins, the DB write is fired async (fire-and-forget) so the
  // PUT /read response time is Redis-bound (~1ms) rather than DB-bound (~10ms).
  // The DB write still happens — it's just not in the critical path.
  //
  // Fail-open matches the previous behavior: if Redis fails, acknowledge the
  // read without blocking HTTP on a direct read_states write.
  const normalizedTsMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  const newTs = String(normalizedTsMs);
  const cursorKey = readCursorTsKey(userId, channelId, conversationId);
  const dbLockKey = readDbLockKey(userId, channelId, conversationId);
  const batchKeys = batchReadStateRedisKeys(userId, channelId, conversationId);
  const messageCreatedAtStr =
    typeof messageCreatedAt === "string"
      ? messageCreatedAt
      : new Date(messageCreatedAt).toISOString();
  let casResult: number = 2; // default: attempt DB write
  let redisCursorMsAtCas0: number | undefined;
  try {
    if (!batchKeys) {
      return { applied: null, didAdvanceCursor: false };
    }
    const rawCas = await redisEvalSha(
      redis,
      REDIS_LUA_IDS.READ_RECEIPT_CURSOR_ADVANCE,
      4,
      cursorKey,
      dbLockKey,
      batchKeys.pendingKey,
      batchKeys.dirtySetKey,
      newTs,
      String(READ_CURSOR_TS_TTL_SECS),
      String(READ_DB_LOCK_TTL_MS),
      batchKeys.dirtyKey,
      messageId,
      messageCreatedAtStr,
      channelId ?? "",
      conversationId ?? "",
      String(batchKeys.pendingTtlSeconds),
    );
    if (Array.isArray(rawCas)) {
      casResult = Number(rawCas[0]);
      if (casResult === 0 && rawCas[1] != null) {
        const r = Number(rawCas[1]);
        if (Number.isFinite(r)) redisCursorMsAtCas0 = r;
      }
    } else if (typeof rawCas === "number" && Number.isFinite(rawCas)) {
      casResult = rawCas;
    } else {
      const n = Number(rawCas);
      casResult = Number.isFinite(n) ? n : 2;
    }
  } catch {
    // Redis unavailable: preserve fail-open read receipt behavior.
    casResult = 2;
  }

  if (casResult === 0) {
    // Cursor already at or ahead of this message — no DB write needed
    return {
      applied: null,
      didAdvanceCursor: false,
      casResult: 0,
      redisCursorMsAtCas0,
    };
  }

  if (casResult === 1) {
    // Cursor advanced in Redis but DB write rate-limited (another write in-flight)
    return {
      applied: {
        last_read_message_id: messageId,
        last_read_at: new Date().toISOString(),
      },
      didAdvanceCursor: true,
      casResult: 1,
    };
  }

  // casResult === 2: the same Redis script already enqueued the dirty read-state
  // payload for the background DB flusher. Return synthetic applied immediately;
  // caller uses last_read_at only for the WS publish payload timestamp.
  return {
    applied: {
      last_read_message_id: messageId,
      last_read_at: new Date().toISOString(),
    },
    didAdvanceCursor: true,
    casResult: 2,
  };
}

registerRedisLuaScript(REDIS_LUA_IDS.READ_RECEIPT_CURSOR_ADVANCE, READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA);
registerRedisLuaScript(
  REDIS_LUA_IDS.READ_RECEIPT_RESET_UNREAD_WATERMARK,
  RESET_UNREAD_WATERMARK_LUA,
);

/**
 * After Redis Lua returns CAS 0, merge the authoritative `read_cursor_ts:*` value into
 * the in-process scope cursor cache. Without this, a worker that only sees CAS 0
 * (cursor advanced elsewhere) records the *attempted* message timestamp and
 * under-estimates the real cursor, so `readReceiptScopeCursorCacheSaysNoAdvance` rarely
 * short-circuits before the next EVAL.
 */
async function rememberReadReceiptScopeCursorMergedWithRedis({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
  messageTsMs,
  redisCursorMsAtCas0,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
  messageTsMs?: number;
  /** When set (from Lua CAS-0), avoids an extra Redis GET on the hot path. */
  redisCursorMsAtCas0?: number;
}) {
  const normalizedMsgMs = Number.isFinite(messageTsMs)
    ? Number(messageTsMs)
    : new Date(messageCreatedAt).getTime();
  let mergedMs = normalizedMsgMs;
  if (Number.isFinite(mergedMs)) {
    if (Number.isFinite(redisCursorMsAtCas0)) {
      mergedMs = Math.max(mergedMs, Number(redisCursorMsAtCas0));
    } else {
      try {
        const raw = await redis.get(readCursorTsKey(userId, channelId, conversationId));
        if (raw != null) {
          const r = Number(raw);
          if (Number.isFinite(r)) mergedMs = Math.max(mergedMs, r);
        }
      } catch {
        // Fail open: keep message-only hint.
      }
    }
  }
  rememberReadReceiptScopeCursor({
    userId,
    channelId,
    conversationId,
    messageCreatedAt: Number.isFinite(mergedMs)
      ? new Date(mergedMs).toISOString()
      : messageCreatedAt,
    messageTsMs: Number.isFinite(mergedMs) ? mergedMs : messageTsMs,
  });
}

module.exports = {
  READ_RECEIPT_DEFER_POOL_WAITING,
  READ_RECEIPT_FANOUT_ENABLED,
  READ_RECEIPT_INVALIDATE_CHANNELS_LIST_CACHE,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  hasConfirmedRecentMessageRead,
  rememberConfirmedMessageRead,
  shouldRunCas1SideEffects,
  shouldCoalesceSameMessageRead,
  readReceiptScopeCursorCacheSaysNoAdvance,
  readReceiptScopeCursorHintSaysNoAdvance,
  rememberReadReceiptScopeCursor,
  shouldCoalesceScopeBurstRead,
  advanceReadStateCursor,
  rememberReadReceiptScopeCursorMergedWithRedis,
};
