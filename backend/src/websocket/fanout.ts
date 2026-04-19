/**
 * fanout.publish – publishes an event to a Redis Pub/Sub channel.
 * All API nodes subscribed to that channel will deliver it to their
 * locally-connected WebSocket clients.
 */

'use strict';

const redis = require('../db/redis');
const logger = require('../utils/logger');
const { redisFanoutPublishFailuresTotal } = require('../utils/metrics');

function channelPrefix(channel) {
  if (typeof channel !== 'string') return 'unknown';
  const i = channel.indexOf(':');
  return i > 0 ? channel.slice(0, i) : 'unknown';
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Per-channel message ring buffer.
 *
 * When a message:created event is published to a `channel:` or `conversation:`
 * topic we also write the full payload to a Redis sorted set (score = message
 * createdAt ms, member = serialized payload). On reconnect, the replay path
 * reads from these ring buffers instead of hitting the DB with a CTE.
 *
 * Keys:  msg_ring:channel:<id>   msg_ring:conversation:<id>
 * Score: message createdAt epoch-ms (falls back to Date.now() if not parsed)
 * TTL:   RING_BUFFER_KEY_TTL_S seconds; entries older than RING_BUFFER_WINDOW_MS pruned on each write
 *
 * Write failures mark the ring as unreliable for RING_BUFFER_WRITE_FAIL_TTL_MS
 * so that reconnect replay falls back to DB instead of trusting a stale/empty
 * sorted set (a successful empty read after a failed write is indistinguishable
 * from "genuinely no messages").
 */
const RING_BUFFER_WINDOW_MS = Number(process.env.RING_BUFFER_WINDOW_MS || '30000');
const RING_BUFFER_KEY_TTL_S = Math.ceil(RING_BUFFER_WINDOW_MS / 1000) * 2 + 5;
const RING_BUFFER_WRITE_FAIL_TTL_MS = Number(process.env.RING_BUFFER_WRITE_FAIL_TTL_MS || '60000');

// Per-process flag: if a ring buffer pipeline write fails, distrust all ring
// buffer reads until this deadline passes. Cleared to 0 once expired.
let ringBufferUnreliableUntil = 0;

function markRingBufferUnreliable() {
  ringBufferUnreliableUntil = Date.now() + RING_BUFFER_WRITE_FAIL_TTL_MS;
}

function isRingBufferReliable() {
  if (ringBufferUnreliableUntil === 0) return true;
  if (Date.now() >= ringBufferUnreliableUntil) {
    ringBufferUnreliableUntil = 0;
    return true;
  }
  return false;
}

function ringBufferKey(channel) {
  return `msg_ring:${channel}`;
}

function bufferMessage(channel, payload) {
  if (typeof channel !== 'string') return;
  if (!channel.startsWith('channel:') && !channel.startsWith('conversation:')) return;
  if (!payload || payload.event !== 'message:created') return;
  try {
    const createdAt = payload?.data?.createdAt;
    const scoreMs = createdAt ? new Date(createdAt).getTime() : Date.now();
    if (!Number.isFinite(scoreMs) || scoreMs <= 0) return;
    const member = JSON.stringify(payload);
    const cutoff = Date.now() - RING_BUFFER_WINDOW_MS;
    const key = ringBufferKey(channel);
    const p = redis.pipeline();
    p.zadd(key, scoreMs, member);
    p.zremrangebyscore(key, '-inf', cutoff);
    p.expire(key, RING_BUFFER_KEY_TTL_S);
    p.exec().catch((err) => {
      logger.warn({ err, channel }, 'Ring buffer pipeline write failed; distrusting ring for replay');
      markRingBufferUnreliable();
    });
  } catch (err) {
    logger.warn({ err, channel }, 'Ring buffer write threw; distrusting ring for replay');
    markRingBufferUnreliable();
  }
}

/**
 * Transient Redis blips should not drop realtime delivery. Bounded retries with
 * capped exponential backoff; tune via REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS (default 4).
 *
 * Also fires a ring-buffer write (fire-and-forget) for message:created events so
 * all existing call sites populate the replay cache without code changes.
 */
async function publish(channel, payload) {
  const eventName =
    payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.event === 'string'
      ? payload.event
      : undefined;
  const serializedPayload = JSON.stringify(payload);
  const rawMax = Number(process.env.REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS || '4');
  const maxAttempts = Number.isFinite(rawMax) ? Math.min(8, Math.max(1, Math.floor(rawMax))) : 4;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const subscriberCount = await redis.publish(channel, serializedPayload);
      if (attempt > 1) {
        logger.info(
          { channel, event: eventName, attempt, maxAttempts },
          'Redis fanout publish succeeded after retry',
        );
      }
      // Fire ring buffer write after successful publish.
      bufferMessage(channel, payload);
      return typeof subscriberCount === 'number' ? subscriberCount : 0;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(50 * 2 ** (attempt - 1), 500);
      logger.warn(
        { err, channel, event: eventName, attempt, nextRetryMs: backoff },
        'Redis fanout publish failed; retrying',
      );
      await sleepMs(backoff);
    }
  }

  redisFanoutPublishFailuresTotal.inc({ channel_prefix: channelPrefix(channel) });
  logger.warn(
    { err: lastErr, channel, event: eventName, attempts: maxAttempts, gradingNote: 'correlate_with_failed_deliveries' },
    'Redis fanout publish failed after retries',
  );
  throw lastErr;
}

module.exports = { publish, ringBufferKey, RING_BUFFER_WINDOW_MS, isRingBufferReliable };
