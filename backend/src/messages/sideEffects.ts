'use strict';

const fanout = require('../websocket/fanout');
const overload = require('../utils/overload');
const logger = require('../utils/logger');
const redis = require('../db/redis');
const { query } = require('../db/pool');
const {
  sideEffectQueueDepth,
  sideEffectQueueActiveWorkers,
  sideEffectQueueDelayMs,
  sideEffectJobDurationMs,
  sideEffectQueueDroppedTotal,
} = require('../utils/metrics');

const queues: Record<string, Array<{ name: string; fn: () => Promise<void>; enqueuedAt: number; queueName: string }>> = {
  'fanout:critical': [],
  'fanout:background': [],
};
const rawFanoutConcurrency = Number(process.env.FANOUT_QUEUE_CONCURRENCY || 4);
const FANOUT_QUEUE_CONCURRENCY = Number.isFinite(rawFanoutConcurrency) && rawFanoutConcurrency > 0
  ? Math.floor(rawFanoutConcurrency)
  : 4;
const rawCriticalMaxDepth = Number(process.env.FANOUT_CRITICAL_MAX_DEPTH || 5000);
const FANOUT_CRITICAL_MAX_DEPTH =
  Number.isFinite(rawCriticalMaxDepth) && rawCriticalMaxDepth > 0
    ? Math.floor(rawCriticalMaxDepth)
    : 5000;
const activeWorkers: Record<string, number> = {
  'fanout:critical': 0,
  'fanout:background': 0,
};

function queueNameForJob(name: string): string {
  // Background fanout jobs are explicitly tagged; everything else is critical.
  if (name.startsWith('fanout:background.')) return 'fanout:background';
  return 'fanout:critical';
}

function queueConfig(queueName) {
  if (queueName === 'fanout:background') {
    return {
      concurrency: 2,
      maxDepth: 10_000,
      dropOnOverflow: true,
    };
  }
  // fanout:critical — message and read-state delivery. Concurrency > 1 is safe
  // because each publish is an independent Redis call; within-channel ordering
  // is best-effort across the cluster anyway (multiple API nodes publish
  // concurrently).  Higher concurrency reduces queue build-up under burst load.
  return {
    concurrency: FANOUT_QUEUE_CONCURRENCY,
    maxDepth: FANOUT_CRITICAL_MAX_DEPTH,
    dropOnOverflow: false,
  };
}

function refreshQueueMetrics(queueName) {
  sideEffectQueueDepth.set({ queue: queueName }, queues[queueName].length);
  sideEffectQueueActiveWorkers.set({ queue: queueName }, activeWorkers[queueName]);
}

function maybeStartWorkers(queueName) {
  const { concurrency } = queueConfig(queueName);
  while (activeWorkers[queueName] < concurrency && queues[queueName].length > 0) {
    activeWorkers[queueName] += 1;
    refreshQueueMetrics(queueName);
    setImmediate(() => {
      void drainWorker(queueName);
    });
  }
}

function enqueue(name, fn) {
  const queueName = queueNameForJob(name);
  const queue = queues[queueName];
  const { maxDepth, dropOnOverflow } = queueConfig(queueName);

  if (dropOnOverflow && queue.length >= maxDepth) {
    sideEffectQueueDroppedTotal.inc({ queue: queueName, name, reason: 'queue_full' });
    logger.warn(
      { sideEffect: name, queue: queueName, queueDepth: queue.length, maxQueueDepth: maxDepth },
      queueName === 'fanout:critical'
        ? 'Dropping fanout:critical side-effect (WS delivery may be missed for this event)'
        : 'Dropping async side-effect due to queue pressure'
    );
    return false;
  }

  queue.push({ name, fn, enqueuedAt: Date.now(), queueName });
  refreshQueueMetrics(queueName);
  maybeStartWorkers(queueName);
  return true;
}

async function drainWorker(queueName) {
  const queue = queues[queueName];
  try {
    while (queue.length) {
      const job = queue.shift();
      refreshQueueMetrics(queueName);
      if (!job) continue;

      const queueDelayMs = Math.max(0, Date.now() - job.enqueuedAt);
      sideEffectQueueDelayMs.observe({ queue: queueName, name: job.name }, queueDelayMs);

      const startedAt = process.hrtime.bigint();
      try {
        await job.fn();
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        sideEffectJobDurationMs.observe(
          { queue: queueName, name: job.name, status: 'success' },
          durationMs
        );
      } catch (err) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        sideEffectJobDurationMs.observe(
          { queue: queueName, name: job.name, status: 'error' },
          durationMs
        );
        logger.warn({ err, sideEffect: job.name, queue: queueName }, 'Async side-effect failed');
      }
    }
  } finally {
    activeWorkers[queueName] = Math.max(0, activeWorkers[queueName] - 1);
    refreshQueueMetrics(queueName);
    if (queue.length) {
      maybeStartWorkers(queueName);
    }
  }
}

refreshQueueMetrics('fanout:critical');
refreshQueueMetrics('fanout:background');

function publishMessageEvent(target, event, data) {
  enqueue('fanout.publish', async () => {
    await fanout.publish(target, { event, data });
  });
}

function publishBackgroundEvent(target, event, data) {
  enqueue('fanout:background.publish', async () => {
    await fanout.publish(target, { event, data });
  });
}

/**
 * For channel message:created events only.
 * Increments channel:msg_count:{channelId} in Redis (initializing from DB if needed),
 * then publishes the WS event. Order guarantees Redis is updated before any client
 * receives the message, so a page reload after the event always sees the correct count.
 */
function publishMessageEventWithUnread(target, event, data, channelId) {
  enqueue('fanout.publish+unread.incr', async () => {
    try {
      // Ensure channel:msg_count is initialized before INCR
      const countKey = `channel:msg_count:${channelId}`;
      const exists = await redis.exists(countKey);
      if (!exists) {
        const { rows } = await query(
          `SELECT COUNT(*)::int AS cnt FROM messages WHERE channel_id = $1 AND deleted_at IS NULL`,
          [channelId]
        );
        const total = rows[0]?.cnt ?? 0;
        // Only SET if still missing (avoid race); use SET NX
        await redis.set(countKey, total, 'NX');
      }
      await redis.incr(countKey);
    } catch (err) {
      logger.warn({ err, channelId }, 'Failed to increment channel:msg_count in Redis');
    }
    await fanout.publish(target, { event, data });
  });
}

/**
 * Queue best-effort S3 object deletion for attachment storage keys that were
 * collected before the message DB row was hard-deleted (ON DELETE CASCADE
 * removes the attachment rows immediately, so they must be captured first).
 */
function deleteAttachmentObjects(storageKeys: string[]) {
  if (!storageKeys.length) return;
  enqueue('s3.deleteAttachments', async () => {
    const { deleteStorageKeys } = require('../attachments/storage');
    await deleteStorageKeys(storageKeys);
  });
}

function getQueueDepth() {
  return queues['fanout:critical'].length + queues['fanout:background'].length;
}

module.exports = {
  publishMessageEvent,
  publishBackgroundEvent,
  publishMessageEventWithUnread,
  deleteAttachmentObjects,
  getQueueDepth,
};
