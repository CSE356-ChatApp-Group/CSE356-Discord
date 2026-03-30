'use strict';

const fanout = require('../websocket/fanout');
const searchClient = require('../search/client');
const overload = require('../utils/overload');
const logger = require('../utils/logger');
const redis = require('../db/redis');
const { pool } = require('../db/pool');

const queue = [];
let draining = false;

function enqueue(name, fn) {
  queue.push({ name, fn, enqueuedAt: Date.now() });
  if (!draining) {
    draining = true;
    setImmediate(drain);
  }
}

async function drain() {
  while (queue.length) {
    const job = queue.shift();
    try {
      await job.fn();
    } catch (err) {
      logger.warn({ err, sideEffect: job.name }, 'Async side-effect failed');
    }
  }
  draining = false;
  if (queue.length) {
    draining = true;
    setImmediate(drain);
  }
}

function publishMessageEvent(target, event, data) {
  enqueue('fanout.publish', async () => {
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
        const { rows } = await pool.query(
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

function indexMessage(message) {
  if (overload.shouldDeferSearchIndexing()) return;
  enqueue('search.indexMessage', async () => {
    await searchClient.indexMessage(message);
  });
}

function deleteMessage(messageId) {
  if (overload.shouldDeferSearchIndexing()) return;
  enqueue('search.deleteMessage', async () => {
    await searchClient.deleteMessage(messageId);
  });
}

function getQueueDepth() {
  return queue.length;
}

module.exports = {
  publishMessageEvent,
  publishMessageEventWithUnread,
  indexMessage,
  deleteMessage,
  getQueueDepth,
};
