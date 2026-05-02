/**
 * Presence fanout_targets Redis cache invalidation (batched UNLINK / DEL fallback).
 */

const client = require('prom-client');

const presenceFanoutTargetsInvalidationTotal = new client.Counter({
  name: 'presence_fanout_targets_invalidation_total',
  help: 'Redis invalidation commands issued for presence fanout_targets cache (one scrape increment per chunk/command)',
  labelNames: ['mode', 'command'],
});

const presenceFanoutTargetsInvalidationKeysTotal = new client.Counter({
  name: 'presence_fanout_targets_invalidation_keys_total',
  help: 'Total presence fanout_targets cache keys invalidated in bulk operations',
  labelNames: ['mode'],
});

const presenceFanoutTargetsInvalidationDurationMs = new client.Histogram({
  name: 'presence_fanout_targets_invalidation_duration_ms',
  help: 'Wall time for presence fanout_targets cache invalidation (single key or full bulk)',
  labelNames: ['mode'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000],
});

module.exports = {
  presenceFanoutTargetsInvalidationTotal,
  presenceFanoutTargetsInvalidationKeysTotal,
  presenceFanoutTargetsInvalidationDurationMs,
};
