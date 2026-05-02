/**
 * Optional Redis duplicate-ack fast path for PUT /messages/:id/read (cross-worker).
 * Key: read_receipt_msg_ack:{userId}:{messageId}
 */

const redis = require('../../db/redis');
const {
  readReceiptNoopSkipTotal,
  readReceiptMessageAckCacheTotal,
} = require('../../utils/metrics');

const ACK_KEY_PREFIX = 'read_receipt_msg_ack:';

function parseMessageAckCacheEnabled(): boolean {
  const v = process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_ENABLED;
  if (v === undefined || v === '') return false;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** Default 60s; clamp 5s–10m. */
function parseMessageAckCacheTtlMs(): number {
  const raw = parseInt(process.env.READ_RECEIPT_MESSAGE_ACK_CACHE_TTL_MS || '60000', 10);
  if (!Number.isFinite(raw)) return 60000;
  return Math.min(600000, Math.max(5000, raw));
}

function readReceiptMessageAckRedisKey(userId: string, messageId: string): string {
  return `${ACK_KEY_PREFIX}${userId}:${messageId}`;
}

/**
 * If cache hit, returns true — caller must return 200 without target/CAS/fanout/flush.
 * Fail-open on Redis errors. No-op when disabled.
 */
async function tryHitReadReceiptMessageAckCache(
  userId: string,
  messageId: string,
): Promise<boolean> {
  if (!parseMessageAckCacheEnabled()) return false;
  const key = readReceiptMessageAckRedisKey(userId, messageId);
  try {
    const v = await redis.get(key);
    if (v == null || v === '') {
      readReceiptMessageAckCacheTotal.inc({ result: 'miss' });
      return false;
    }
    readReceiptMessageAckCacheTotal.inc({ result: 'hit' });
    readReceiptNoopSkipTotal.inc({ reason: 'redis_message_ack_cache' });
    return true;
  } catch {
    readReceiptMessageAckCacheTotal.inc({ result: 'get_error' });
    return false;
  }
}

/**
 * Records successful read for (user, message) after access was confirmed via target lookup.
 * Fail-open: never throws.
 */
async function recordReadReceiptMessageAckAfterSuccess(
  userId: string,
  messageId: string,
): Promise<void> {
  if (!parseMessageAckCacheEnabled()) return;
  const key = readReceiptMessageAckRedisKey(userId, messageId);
  const ttl = parseMessageAckCacheTtlMs();
  try {
    await redis.set(key, '1', 'PX', ttl);
    readReceiptMessageAckCacheTotal.inc({ result: 'set_ok' });
  } catch {
    readReceiptMessageAckCacheTotal.inc({ result: 'set_error' });
  }
}

module.exports = {
  parseMessageAckCacheEnabled,
  parseMessageAckCacheTtlMs,
  readReceiptMessageAckRedisKey,
  tryHitReadReceiptMessageAckCache,
  recordReadReceiptMessageAckAfterSuccess,
};
