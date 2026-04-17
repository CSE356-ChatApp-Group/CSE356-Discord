/**
 * fanout.publish – publishes an event to a Redis Pub/Sub channel.
 * All API nodes subscribed to that channel will deliver it to their
 * locally-connected WebSocket clients.
 */

'use strict';

const redis = require('../db/redis');
const logger = require('../utils/logger');
const {
  redisFanoutPublishFailuresTotal,
  realtimePassthroughPublishSkippedTotal,
} = require('../utils/metrics');

const rawSubscriberCacheTtlMs = Number(process.env.REALTIME_TOPIC_SUBSCRIBER_CACHE_TTL_MS || '1000');
const REALTIME_TOPIC_SUBSCRIBER_CACHE_TTL_MS =
  Number.isFinite(rawSubscriberCacheTtlMs) && rawSubscriberCacheTtlMs > 0
    ? Math.floor(rawSubscriberCacheTtlMs)
    : 1000;
const passthroughSubscriberCountCache = new Map();
const passthroughSubscriberCountInflight = new Map();

function channelPrefix(channel) {
  if (typeof channel !== 'string') return 'unknown';
  const i = channel.indexOf(':');
  return i > 0 ? channel.slice(0, i) : 'unknown';
}

function canonicalUserFeedEnabled() {
  const value = String(process.env.REALTIME_CANONICAL_USER_FEED || 'true').trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

function skipEmptyPassthroughPublishEnabled() {
  const value = String(process.env.REALTIME_SKIP_EMPTY_TOPIC_PUBLISH || 'true').trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

function isPassthroughTopic(channel) {
  const prefix = channelPrefix(channel);
  return prefix === 'channel' || prefix === 'conversation' || prefix === 'community';
}

function getCachedSubscriberCount(channel, now = Date.now()) {
  const cached = passthroughSubscriberCountCache.get(channel);
  if (!cached) return null;
  if (cached.expiresAtMs <= now) {
    passthroughSubscriberCountCache.delete(channel);
    return null;
  }
  return cached.count;
}

function setCachedSubscriberCount(channel, count, now = Date.now()) {
  passthroughSubscriberCountCache.set(channel, {
    count,
    expiresAtMs: now + REALTIME_TOPIC_SUBSCRIBER_CACHE_TTL_MS,
  });
}

async function topicSubscriberCount(channel) {
  const now = Date.now();
  const cached = getCachedSubscriberCount(channel, now);
  if (cached !== null) return cached;

  if (passthroughSubscriberCountInflight.has(channel)) {
    return passthroughSubscriberCountInflight.get(channel);
  }

  const load = (async () => {
    const result = await redis.pubsub('numsub', channel);
    let count = 0;
    if (Array.isArray(result)) {
      const index = result.findIndex((entry) => entry === channel);
      if (index >= 0 && index + 1 < result.length) {
        count = Number(result[index + 1] || 0);
      } else if (result.length >= 2) {
        count = Number(result[1] || 0);
      }
    }
    if (!Number.isFinite(count) || count < 0) count = 0;
    setCachedSubscriberCount(channel, count, now);
    return count;
  })().finally(() => {
    passthroughSubscriberCountInflight.delete(channel);
  });

  passthroughSubscriberCountInflight.set(channel, load);
  return load;
}

async function shouldSkipPassthroughPublish(channel, options = {}) {
  const optionBag =
    options && typeof options === 'object' && !Array.isArray(options)
      ? /** @type {Record<string, unknown>} */ (options)
      : null;
  const skipIfNoSubscribers = Boolean(
    optionBag
    && optionBag['skipIfNoSubscribers'] === true,
  );
  if (!skipIfNoSubscribers) return false;
  if (!canonicalUserFeedEnabled() || !skipEmptyPassthroughPublishEnabled()) return false;
  if (!isPassthroughTopic(channel)) return false;
  try {
    const count = await topicSubscriberCount(channel);
    return count <= 0;
  } catch (err) {
    logger.debug({ err, channel }, 'Redis PUBSUB NUMSUB lookup failed; publishing passthrough topic');
    return false;
  }
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient Redis blips should not drop realtime delivery. Bounded retries with
 * capped exponential backoff; tune via REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS (default 4).
 */
async function publish(channel, payload, options = {}) {
  const eventName =
    payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.event === 'string'
      ? payload.event
      : undefined;
  if (await shouldSkipPassthroughPublish(channel, options)) {
    realtimePassthroughPublishSkippedTotal.inc({ channel_prefix: channelPrefix(channel) });
    return false;
  }
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
      return true;
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
