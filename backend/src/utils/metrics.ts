'use strict';

const client = require('prom-client');

client.register.setDefaultLabels({
  service: 'chatapp-api',
  env: process.env.NODE_ENV || 'development',
});

// Collect default Node.js process metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_server_requests_total',
  help: 'Total number of completed HTTP requests',
  labelNames: ['method', 'route', 'status_class'],
});

const httpRequestDurationMs = new client.Histogram({
  name: 'http_server_request_duration_ms',
  help: 'Latency of completed HTTP requests in milliseconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

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
  httpRequestsTotal,
  httpRequestDurationMs,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
};
