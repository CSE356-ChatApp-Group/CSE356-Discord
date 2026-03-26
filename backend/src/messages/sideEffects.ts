'use strict';

const fanout = require('../websocket/fanout');
const searchClient = require('../search/client');
const overload = require('../utils/overload');
const logger = require('../utils/logger');

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
  indexMessage,
  deleteMessage,
  getQueueDepth,
};
