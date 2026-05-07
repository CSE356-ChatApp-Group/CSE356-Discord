#!/usr/bin/env node
// Collect per-route p99 diagnostics and write to a file
const http = require('http');
const fs = require('fs');

const BASE = process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090';
const RANGE = '10m';

function query(promql) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}/api/v1/query?query=${encodeURIComponent(promql)}`;
    http.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({raw: data}); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const out = [];
  const log = (s) => { out.push(s); console.log(s); };

  log(`=== Route P99 Diagnostics === ${new Date().toISOString()} ===`);
  log('');

  // Current p99 per route
  log('--- P99 PER ROUTE ---');
  const r1 = await query(`histogram_quantile(0.99, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[${RANGE}])))`);
  if (r1.data) {
    for (const r of r1.data.result) {
      const v = parseFloat(r.value[1]);
      if (!isNaN(v)) log(`  ${r.metric.route.padEnd(45)} p99=${v.toFixed(0)}ms`);
    }
  }

  log('');
  log('--- P95 PER ROUTE ---');
  const r2 = await query(`histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_ms_bucket{job="chatapp-api"}[${RANGE}])))`);
  if (r2.data) {
    for (const r of r2.data.result) {
      const v = parseFloat(r.value[1]);
      if (!isNaN(v)) log(`  ${r.metric.route.padEnd(45)} p95=${v.toFixed(0)}ms`);
    }
  }

  log('');
  log('--- REQUEST RATE PER ROUTE ---');
  const r3 = await query(`sum by (route) (rate(http_server_requests_total{job="chatapp-api"}[${RANGE}]))`);
  if (r3.data) {
    for (const r of r3.data.result.sort((a,b) => parseFloat(b.value[1]) - parseFloat(a.value[1]))) {
      log(`  ${r.metric.route.padEnd(45)} ${parseFloat(r.value[1]).toFixed(2)} req/s`);
    }
  }

  log('');
  log('--- BCRYPT QUEUE ---');
  const bcryptMetrics = [
    ['max(bcrypt_queue_depth{job="chatapp-api"})', 'queue_depth'],
    ['max(auth_bcrypt_active{job="chatapp-api"})', 'active'],
    ['max(auth_bcrypt_waiters{job="chatapp-api"})', 'waiters'],
    ['sum(rate(auth_bcrypt_queue_rejects_total{job="chatapp-api"}['+RANGE+']))', 'rejects/s'],
    ['histogram_quantile(0.99, sum by (le) (rate(bcrypt_queue_wait_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'wait_p99_ms'],
  ];
  for (const [q, label] of bcryptMetrics) {
    const r = await query(q);
    if (r.data && r.data.result.length) log(`  ${label}: ${r.data.result[0].value[1]}`);
    else log(`  ${label}: no data`);
  }

  log('');
  log('--- AUTH SESSION / SIDE-EFFECT QUEUE ---');
  const authMetrics = [
    ['histogram_quantile(0.99, sum by (le) (rate(auth_session_flow_duration_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'session_flow_p99_ms'],
    ['max(side_effect_queue_depth{job="chatapp-api"})', 'side_effect_queue_depth'],
    ['histogram_quantile(0.99, sum by (le) (rate(side_effect_queue_wait_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'side_effect_wait_p99_ms'],
  ];
  for (const [q, label] of authMetrics) {
    const r = await query(q);
    if (r.data && r.data.result.length) log(`  ${label}: ${r.data.result[0].value[1]}`);
    else log(`  ${label}: no data`);
  }

  log('');
  log('--- PG POOL + ERRORS ---');
  const pgMetrics = [
    ['max(pg_pool_waiting{job="chatapp-api"})', 'pool_waiting'],
    ['max(pg_pool_idle{job="chatapp-api"})', 'pool_idle'],
    ['max(pg_pool_total{job="chatapp-api"})', 'pool_total'],
    ['sum by (reason)(rate(pg_pool_operation_errors_total{job="chatapp-api"}['+RANGE+']))', 'errors'],
    ['sum(rate(pg_pool_circuit_breaker_rejects_total{job="chatapp-api"}['+RANGE+']))', 'cb_rejects/s'],
    ['sum(rate(pg_pool_query_gate_rejects_total{job="chatapp-api"}['+RANGE+']))', 'query_gate_rejects/s'],
  ];
  for (const [q, label] of pgMetrics) {
    const r = await query(q);
    if (r.data && r.data.result.length) {
      if (r.data.result.length === 1) log(`  ${label}: ${r.data.result[0].value[1]}`);
      else for (const x of r.data.result) log(`  ${label}(${x.metric.reason || x.metric.endpoint || ''}): ${x.value[1]}`);
    } else log(`  ${label}: no data`);
  }

  log('');
  log('--- SEARCH SPECIFIC ---');
  const searchMetrics = [
    ['histogram_quantile(0.99, sum by (le) (rate(search_query_duration_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'search_duration_p99'],
    ['histogram_quantile(0.95, sum by (le) (rate(search_query_duration_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'search_duration_p95'],
    ['sum by (result)(rate(search_freshness_cache_total{job="chatapp-api"}['+RANGE+']))', 'freshness_cache'],
    ['sum by (result)(rate(search_meili_fallback_total{job="chatapp-api"}['+RANGE+']))', 'meili_fallback'],
    ['sum(rate(search_replica_retry_total{job="chatapp-api"}['+RANGE+']))', 'replica_retries/s'],
    ['sum(rate(search_throttle_total{job="chatapp-api"}['+RANGE+']))', 'throttles/s'],
    ['histogram_quantile(0.99, sum by (le) (rate(search_handler_overhead_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'handler_overhead_p99'],
  ];
  for (const [q, label] of searchMetrics) {
    const r = await query(q);
    if (r.data && r.data.result.length) {
      if (r.data.result.length === 1) log(`  ${label}: ${r.data.result[0].value[1]}`);
      else for (const x of r.data.result) log(`  ${label}(${x.metric.result || ''}): ${x.value[1]}`);
    } else log(`  ${label}: no data`);
  }

  log('');
  log('--- ENDPOINT LIST CACHE ---');
  const rCache = await query(`sum by (endpoint, result) (rate(endpoint_list_cache_total{job="chatapp-api"}[${RANGE}]))`);
  if (rCache.data) {
    for (const r of rCache.data.result.sort((a,b) => (a.metric.endpoint+a.metric.result).localeCompare(b.metric.endpoint+b.metric.result))) {
      log(`  ${r.metric.endpoint.padEnd(35)} ${r.metric.result.padEnd(10)} ${parseFloat(r.value[1]).toFixed(4)}/s`);
    }
  }

  log('');
  log('--- MESSAGE INSERT LOCK ---');
  const lockMetrics = [
    ['histogram_quantile(0.95, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}['+RANGE+'])))', 'lock_wait_p95'],
    ['histogram_quantile(0.99, sum by (le, vm) (rate(message_channel_insert_lock_wait_ms_bucket{job="chatapp-api",result="acquired"}['+RANGE+'])))', 'lock_wait_p99'],
    ['histogram_quantile(0.95, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'lock_holder_p95'],
    ['histogram_quantile(0.99, sum by (le, vm) (rate(message_insert_lock_holder_duration_ms_bucket{job="chatapp-api"}['+RANGE+'])))', 'lock_holder_p99'],
    ['max by (vm, instance) (message_channel_insert_lock_pressure_recent_timeout_count{job="chatapp-api"})', 'pressure_timeouts'],
    ['max by (vm, instance) (message_channel_insert_lock_pressure_wait_p95_ms{job="chatapp-api"})', 'pressure_wait_p95'],
  ];
  for (const [q, label] of lockMetrics) {
    const r = await query(q);
    if (r.data && r.data.result.length) {
      for (const x of r.data.result) log(`  ${label}(${x.metric.vm || ''}): ${x.value[1]}`);
    } else log(`  ${label}: no data`);
  }

  log('');
  log('--- MESSAGE POST P95/P99 BY VM ---');
  const msgPost = [
    ['histogram_quantile(0.95, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}['+RANGE+'])))', 'POST/messages_p95'],
    ['histogram_quantile(0.99, sum by (le, vm) (rate(http_server_request_duration_ms_bucket{job="chatapp-api",method="POST",route="/api/v1/messages/"}['+RANGE+'])))', 'POST/messages_p99'],
  ];
  for (const [q, label] of msgPost) {
    const r = await query(q);
    if (r.data) for (const x of r.data.result) log(`  ${label}(${x.metric.vm || ''}): ${x.value[1]}`);
  }

  log('');
  log('--- OVERLOAD ---');
  const ov = await query('max(chatapp_overload_stage{job="chatapp-api"})');
  if (ov.data && ov.data.result.length) log(`  overload_stage: ${ov.data.result[0].value[1]}`);
  const shed = await query(`sum(rate(http_overload_shed_total{job="chatapp-api"}[${RANGE}]))`);
  if (shed.data && shed.data.result.length) log(`  overload_shed/s: ${shed.data.result[0].value[1]}`);

  log('');
  log('--- PG QUERIES PER REQUEST ---');
  const pgQ = await query(`histogram_quantile(0.99, sum by (le, route) (rate(pg_business_sql_queries_per_http_request_bucket{job="chatapp-api"}[${RANGE}])))`);
  if (pgQ.data) {
    for (const r of pgQ.data.result.sort((a,b) => {
      const va = parseFloat(a.value[1]), vb = parseFloat(b.value[1]);
      if (isNaN(va)) return 1; if (isNaN(vb)) return -1;
      return vb - va;
    })) {
      const v = parseFloat(r.value[1]);
      if (!isNaN(v)) log(`  ${r.metric.route.padEnd(45)} p99_queries=${v.toFixed(1)}`);
    }
  }

  const outputPath = 'var/route-p99-diag.txt';
  fs.writeFileSync(outputPath, out.join('\n') + '\n');
  console.log(`\nWrote ${outputPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });