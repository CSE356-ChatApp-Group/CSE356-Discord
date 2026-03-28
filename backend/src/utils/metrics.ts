'use strict';

const client = require('prom-client');

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics();

// ── Presence fanout ────────────────────────────────────────────────────────────

/**
 * Counts every call to setPresence(), labelled by the target status and
 * whether the fanout was suppressed by the overload guard.
 *
 * Labels:
 *   status    – online | idle | away | offline
 *   throttled – true | false
 */
const presenceFanoutTotal = new client.Counter({
  name: 'presence_fanout_total',
  help: 'Number of presence state changes, partitioned by status and whether the Redis fanout was throttled',
  labelNames: ['status', 'throttled'],
});

/**
 * Distribution of how many local WebSocket clients received a message
 * when the Redis pub/sub handler fired.
 *
 * Labels:
 *   channel_type – user | channel | conversation
 */
const fanoutRecipientsHistogram = new client.Histogram({
  name: 'presence_fanout_recipients',
  help: 'Number of local WebSocket recipients per Redis pub/sub delivery, by channel type',
  labelNames: ['channel_type'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500],
});

module.exports = {
  register: client.register,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
};
