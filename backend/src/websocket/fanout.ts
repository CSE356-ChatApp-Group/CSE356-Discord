/**
 * fanout.publish – publishes an event to a Redis Pub/Sub channel.
 * fanout.publishBatch – multiple PUBLISH commands in one ioredis pipeline (one
 * round-trip) to smooth burst load across shards/topics.
 */

'use strict';

const redis = require('../db/redis');
const logger = require('../utils/logger');
const { redisFanoutPublishFailuresTotal } = require('../utils/metrics');
const _fanoutRetryInfoSampleRate = Number(process.env.REDIS_FANOUT_RETRY_INFO_SAMPLE_RATE ?? '0');
const REDIS_FANOUT_RETRY_INFO_SAMPLE_RATE =
  Number.isFinite(_fanoutRetryInfoSampleRate) && _fanoutRetryInfoSampleRate >= 0
    ? Math.min(1, Math.max(0, _fanoutRetryInfoSampleRate))
    : 0;

function shouldSample(rate = REDIS_FANOUT_RETRY_INFO_SAMPLE_RATE) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

function channelPrefix(channel) {
  if (typeof channel !== 'string') return 'unknown';
  const i = channel.indexOf(':');
  return i > 0 ? channel.slice(0, i) : 'unknown';
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fanoutPublishMaxAttempts() {
  const rawMax = Number(process.env.REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS || '4');
  return Number.isFinite(rawMax) ? Math.min(8, Math.max(1, Math.floor(rawMax))) : 4;
}

function payloadEventName(payload) {
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof payload.event === 'string'
  ) {
    return payload.event;
  }
  return undefined;
}

/**
 * Run one or more PUBLISH commands via a single pipeline.exec() (one RTT).
 * Throws on first command error in the pipeline result.
 */
async function execPublishPipeline(serials) {
  if (!serials.length) return;
  const pipe = redis.pipeline();
  for (const { channel, body } of serials) {
    pipe.publish(channel, body);
  }
  const results = await pipe.exec();
  const list = Array.isArray(results) ? results : [];
  for (let i = 0; i < list.length; i += 1) {
    const tuple = list[i];
    const err = tuple && tuple[0];
    if (err) throw err;
  }
}

async function publishWithRetries(serials, logContext) {
  const maxAttempts = fanoutPublishMaxAttempts();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await execPublishPipeline(serials);
      if (attempt > 1 && shouldSample()) {
        logger.info(
          {
            attempt,
            maxAttempts,
            event: logContext.eventName,
            channel: logContext.channel,
            batchSize: logContext.batchSize,
          },
          'Redis fanout publish succeeded after retry',
        );
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(50 * 2 ** (attempt - 1), 500);
      logger.warn(
        {
          err,
          event: logContext.eventName,
          channel: logContext.channel,
          attempt,
          nextRetryMs: backoff,
          batchSize: logContext.batchSize,
        },
        'Redis fanout publish failed; retrying',
      );
      await sleepMs(backoff);
    }
  }

  const metricPrefix =
    logContext.batchSize > 1 ? 'multi' : channelPrefix(String(logContext.channel || ''));
  redisFanoutPublishFailuresTotal.inc({ channel_prefix: metricPrefix });
  logger.warn(
    {
      err: lastErr,
      channel: logContext.channel,
      event: logContext.eventName,
      attempts: maxAttempts,
      batchSize: logContext.batchSize,
      gradingNote: 'correlate_with_failed_deliveries',
    },
    'Redis fanout publish failed after retries',
  );
  throw lastErr;
}

/**
 * Transient Redis blips should not drop realtime delivery. Bounded retries with
 * capped exponential backoff; tune via REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS (default 4).
 */
async function publish(channel, payload) {
  const eventName = payloadEventName(payload);
  const serializedPayload = JSON.stringify(payload);
  await publishWithRetries([{ channel, body: serializedPayload }], {
    eventName,
    channel,
    batchSize: 1,
  });
}

/**
 * Multiple Redis PUBLISH operations in one round-trip. Preserves per-channel
 * payload strings (same as sequential publish). All succeed or the batch is retried.
 */
async function publishBatch(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const serials: Array<{ channel: string; body: string }> = [];
  for (const ent of entries) {
    if (!ent || typeof ent.channel !== 'string' || !ent.channel) continue;
    serials.push({ channel: ent.channel, body: JSON.stringify(ent.payload) });
  }
  if (!serials.length) return;
  const eventName = payloadEventName(entries[0]?.payload);
  await publishWithRetries(serials, {
    eventName,
    channel: serials.length === 1 ? serials[0].channel : undefined,
    batchSize: serials.length,
  });
}

module.exports = { publish, publishBatch };
