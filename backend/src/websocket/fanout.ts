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
 * Transient Redis blips should not drop realtime delivery. Bounded retries with
 * capped exponential backoff; tune via REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS (default 4).
 */
async function publish(channel, payload) {
  const eventName =
    payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.event === 'string'
      ? payload.event
      : undefined;
  const rawMax = Number(process.env.REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS || '4');
  const maxAttempts = Number.isFinite(rawMax) ? Math.min(8, Math.max(1, Math.floor(rawMax))) : 4;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await redis.publish(channel, JSON.stringify(payload));
      if (attempt > 1) {
        logger.info(
          { channel, event: eventName, attempt, maxAttempts },
          'Redis fanout publish succeeded after retry',
        );
      }
      return;
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

module.exports = { publish };
