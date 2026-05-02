/**
 * Message target (msg_target Redis + PG replica/primary) observability for
 * loadMessageTargetForUser — low-cardinality labels only.
 */

const client = require('prom-client');

const msgTargetCacheTotal = new client.Counter({
  name: 'msg_target_cache_total',
  help: 'msg_target Redis scoped cache read outcomes',
  labelNames: ['caller', 'shape', 'result'],
});

const msgTargetLookupSourceTotal = new client.Counter({
  name: 'msg_target_lookup_source_total',
  help: 'Message target row resolution source after loadMessageTargetForUser',
  labelNames: ['caller', 'shape', 'source'],
});

const msgTargetLookupDurationMs = new client.Histogram({
  name: 'msg_target_lookup_duration_ms',
  help: 'Wall time for loadMessageTargetForUser (cache + DB path)',
  labelNames: ['caller', 'shape', 'source'],
  buckets: [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
});

module.exports = {
  msgTargetCacheTotal,
  msgTargetLookupSourceTotal,
  msgTargetLookupDurationMs,
};
