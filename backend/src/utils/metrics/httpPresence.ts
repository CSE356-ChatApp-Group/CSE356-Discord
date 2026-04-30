/**
 * HTTP request + presence fanout Prometheus metrics (registered with the default prom-client registry).
 */

const client = require('prom-client');

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

/** Client disconnected or response aborted before `finish` (correlates with k6 status 0). */
const httpRequestsAbortedTotal = new client.Counter({
  name: 'http_server_requests_aborted_total',
  help: 'HTTP responses where the connection closed before the response finished (no finish event)',
  labelNames: ['method', 'route'],
});

/** Incremented when middleware rejects a request due to event-loop lag (overload shed). */
const httpOverloadShedTotal = new client.Counter({
  name: 'http_overload_shed_total',
  help: 'HTTP requests rejected early by event-loop lag shedding (429 before route handlers)',
});

/**
 * Counts every call to setPresence(), labelled by the target status and
 * whether the fanout was suppressed by the overload guard.
 */
const presenceFanoutTotal = new client.Counter({
  name: 'presence_fanout_total',
  help: 'Number of presence state changes, partitioned by status and whether the Redis fanout was throttled',
  labelNames: ['status', 'throttled'],
});

/**
 * Distribution of how many local WebSocket clients received a message
 * when the Redis pub/sub handler fired.
 */
const fanoutRecipientsHistogram = new client.Histogram({
  name: 'presence_fanout_recipients',
  help: 'Number of local WebSocket recipients per Redis pub/sub delivery, by channel type',
  labelNames: ['channel_type'],
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500],
});

module.exports = {
  httpRequestsTotal,
  httpRequestDurationMs,
  httpRequestsAbortedTotal,
  httpOverloadShedTotal,
  presenceFanoutTotal,
  fanoutRecipientsHistogram,
};
