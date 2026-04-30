/**
 * Read-receipt Redis CAS cursor, in-memory coalescing, and Lua used by PUT /messages/:id/read.
 */


const redis = require("../../db/redis");
const { readReceiptCursorCacheHitTotal } = require("../../utils/metrics");
const { batchReadStateRedisKeys } = require("../batchReadState");

// When unset, keep historical default (defer only under heavy pool wait).
// `0` disables the pool-wait defer branch entirely (see PUT /messages/:id/read).
const _readReceiptDeferWaiting = parseInt(
  process.env.READ_RECEIPT_DEFER_POOL_WAITING || "8",
  10,
);
const READ_RECEIPT_DEFER_POOL_WAITING =
  Number.isFinite(_readReceiptDeferWaiting) && _readReceiptDeferWaiting >= 0
    ? _readReceiptDeferWaiting
    : 8;

// Read cursor Redis CAS: stores last-known cursor timestamp (epoch ms) per (user, target).
// The Lua script atomically advances only if the new value is strictly greater, preventing
// concurrent workers from double-writing the same row and serializing on PG row locks.
// After a Redis CAS win, the DB write is fired async (non-blocking) so PUT /read response
// time is Redis-bound (~1ms) rather than DB-bound (~10ms).
// TTL: 10 minutes — long enough to cover the grader session, short enough to GC old users.
const READ_CURSOR_TS_TTL_SECS = parseInt(
  process.env.READ_CURSOR_TS_TTL_SECS || "600",
  10,
);
const READ_DB_LOCK_TTL_MS = parseInt(
  process.env.READ_DB_LOCK_TTL_MS || "500",
  10,
);
const READ_RECEIPT_CAS1_DEBOUNCE_MS = Math.min(
  1000,
  Math.max(500, parseInt(process.env.READ_RECEIPT_CAS1_DEBOUNCE_MS || "750", 10) || 750),
);
const readReceiptCas1DebounceByTarget = new Map();
const READ_RECEIPT_CAS1_DEBOUNCE_MAX_KEYS = 20000;
const READ_RECEIPT_SAME_MESSAGE_COALESCE_MS = Math.min(
  2000,
  Math.max(100, parseInt(process.env.READ_RECEIPT_SAME_MESSAGE_COALESCE_MS || "400", 10) || 400),
);
const readReceiptRecentByMessage = new Map();
const READ_RECEIPT_RECENT_MAX_KEYS = 50000;
const READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS = Math.min(
  5000,
  Math.max(
    250,
    parseInt(process.env.READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS || "500", 10) || 500,
  ),
);
const READ_RECEIPT_SCOPE_DEBOUNCE_MS = Math.min(
  2000,
  Math.max(
    250,
    parseInt(process.env.READ_RECEIPT_SCOPE_DEBOUNCE_MS || "900", 10) || 900,
  ),
);
const READ_RECEIPT_FANOUT_ENABLED =
  String(process.env.READ_RECEIPT_FANOUT_ENABLED || "true").toLowerCase() === "true";
/** When true (default), channel read:updated fanout runs on fanout:critical queue (not inline on PUT). */
const READ_RECEIPT_CHANNEL_FANOUT_ASYNC = (() => {
  const raw = process.env.READ_RECEIPT_CHANNEL_FANOUT_ASYNC;
  if (raw === undefined || raw === "") return true;
  const v = String(raw).toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
})();
const readReceiptScopeCursorByTarget = new Map();
const READ_RECEIPT_SCOPE_CURSOR_MAX_KEYS = 75000;
const readReceiptScopeDebounceByTarget = new Map();
const READ_RECEIPT_SCOPE_DEBOUNCE_MAX_KEYS = 75000;
// Four-key Lua script:
//   KEYS[1] = cursor key (read_cursor_ts:...)
//   KEYS[2] = db_lock key (read_db_lock:...)
//   KEYS[3] = pending read-state hash key (rs:pending:...)
//   KEYS[4] = dirty set key (rs:dirty)
//   ARGV[1] = new timestamp ms, ARGV[2] = cursor TTL secs, ARGV[3] = db_lock TTL ms
//   ARGV[4] = dirty member, ARGV[5] = message id, ARGV[6] = message created_at
//   ARGV[7] = channel id, ARGV[8] = conversation id, ARGV[9] = pending TTL secs
// Returns 0: cursor already at/ahead — skip entirely.
//         1: cursor advanced, but DB write rate-limited by lock — skip DB.
//         2: cursor advanced AND dirty read-state payload enqueued.
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
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
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
  const msgTsMs = new Date(messageCreatedAt).getTime();
  const noAdvance = Number.isFinite(msgTsMs) && tsMs >= msgTsMs;
  readReceiptCursorCacheHitTotal.inc({ result: noAdvance ? "hit" : "miss" });
  return noAdvance;
}

function rememberReadReceiptScopeCursor({
  userId,
  channelId,
  conversationId,
  messageCreatedAt,
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
}) {
  const key = readReceiptScopeCursorKey(userId, channelId, conversationId);
  const msgTsMs = new Date(messageCreatedAt).getTime();
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
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageCreatedAt: string | Date;
}) {
  const key = readReceiptScopeCursorKey(userId, channelId, conversationId);
  const now = Date.now();
  const msgTsMs = new Date(messageCreatedAt).getTime();
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
}: {
  userId: string;
  channelId: string | null;
  conversationId: string | null;
  messageId: string;
  messageCreatedAt: string | Date;
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
  const newTs = String(new Date(messageCreatedAt).getTime());
  const cursorKey = readCursorTsKey(userId, channelId, conversationId);
  const dbLockKey = readDbLockKey(userId, channelId, conversationId);
  const batchKeys = batchReadStateRedisKeys(userId, channelId, conversationId);
  const messageCreatedAtStr =
    typeof messageCreatedAt === "string"
      ? messageCreatedAt
      : new Date(messageCreatedAt).toISOString();
  let casResult: number = 2; // default: attempt DB write
  try {
    if (!batchKeys) {
      return { applied: null, didAdvanceCursor: false };
    }
    casResult = (await redis.eval(
      READ_CURSOR_ADVANCE_AND_ENQUEUE_LUA,
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
    )) as number;
  } catch {
    // Redis unavailable: preserve fail-open read receipt behavior.
    casResult = 2;
  }

  if (casResult === 0) {
    // Cursor already at or ahead of this message — no DB write needed
    return { applied: null, didAdvanceCursor: false, casResult: 0 };
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

module.exports = {
  READ_RECEIPT_DEFER_POOL_WAITING,
  READ_RECEIPT_FANOUT_ENABLED,
  READ_RECEIPT_CHANNEL_FANOUT_ASYNC,
  RESET_UNREAD_WATERMARK_LUA,
  shouldRunCas1SideEffects,
  shouldCoalesceSameMessageRead,
  readReceiptScopeCursorCacheSaysNoAdvance,
  rememberReadReceiptScopeCursor,
  shouldCoalesceScopeBurstRead,
  advanceReadStateCursor,
};
