#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const runDir = process.argv[2];
const exitCode = Number(process.argv[3] || 0);

if (!runDir) {
  console.error('Usage: node scripts/render-capacity-report.mjs <run-dir> [k6-exit-code]');
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function metric(summary, name, stat) {
  const entry = summary?.metrics?.[name];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.values && Object.prototype.hasOwnProperty.call(entry.values, stat)) {
    return entry.values[stat];
  }
  if (Object.prototype.hasOwnProperty.call(entry, stat)) {
    return entry[stat];
  }
  return null;
}

/** k6 Counter summary uses `count`; omit when zero in some exports. */
function metricCounter(summary, name) {
  const v = metric(summary, name, 'count');
  return typeof v === 'number' ? v : null;
}

function collectThresholdBreaches(summary) {
  const out = [];
  const metrics = summary?.metrics;
  if (!metrics) return out;
  for (const [metricName, entry] of Object.entries(metrics)) {
    if (!entry?.thresholds || typeof entry.thresholds !== 'object') continue;
    for (const [expr, breached] of Object.entries(entry.thresholds)) {
      // k6 `summary.json`: **true** = threshold violated, **false** = satisfied
      // (the key is the expression string, e.g. `p(95)<1500`).
      if (breached !== true) continue;
      out.push({ metric: metricName, expr });
    }
  }
  const seen = new Set();
  return out.filter((b) => {
    const k = `${b.metric}|${b.expr}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function gatherPrometheusQueryErrors(snapshot) {
  if (!snapshot?.queries) return [];
  return Object.entries(snapshot.queries)
    .filter(([, v]) => v && v.status === 'error')
    .map(([name, v]) => ({ name, error: v.error || 'unknown' }));
}

function fmt(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (typeof value === 'number') {
    if (Math.abs(value) >= 100) return `${value.toFixed(0)}${suffix}`;
    if (Math.abs(value) >= 10) return `${value.toFixed(1)}${suffix}`;
    return `${value.toFixed(2)}${suffix}`;
  }
  return `${value}${suffix}`;
}

function promResult(snapshot, key) {
  return snapshot?.queries?.[key]?.data?.result ?? [];
}

function promScalar(snapshot, key, emptyValue = null) {
  const result = promResult(snapshot, key);
  if (!Array.isArray(result) || result.length === 0) return emptyValue;
  const raw = result[0]?.value?.[1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : emptyValue;
}

function promScalarPrefer(snapshot, primaryKey, fallbackKey, emptyValue = null) {
  let v = promScalar(snapshot, primaryKey, emptyValue);
  if (v === null || v === emptyValue) {
    const fb = promScalar(snapshot, fallbackKey, emptyValue);
    if (fb !== null && fb !== emptyValue) return fb;
  }
  return v;
}

function counterAbsentNote(val) {
  if (val === null) return ' (counter absent from summary — treated as 0)';
  return '';
}

function readMetadata(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('=');
        if (idx <= 0) return null;
        return [line.slice(0, idx), line.slice(idx + 1)];
      })
      .filter(Boolean);
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

function summarizeAppErrors(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return { total: 0, signatures: [] };

  const signatures = new Map();
  for (const line of lines) {
    let key = line;
    try {
      const obj = JSON.parse(line);
      const msg = obj.msg || obj.message || 'log';
      const errCode = obj.err?.code || obj.code || '';
      const errMsg = obj.err?.message || obj.error || '';
      key = `${msg}|${errCode}|${errMsg}`.slice(0, 400);
    } catch {
      key = line.slice(0, 400);
    }
    signatures.set(key, (signatures.get(key) || 0) + 1);
  }

  return {
    total: lines.length,
    signatures: [...signatures.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// Stream metrics.ndjson once and derive timeline + failure attribution.
async function analyzeNdjson(ndjsonPath) {
  if (!fs.existsSync(ndjsonPath)) return null;
  let startTime = null;
  const buckets = new Map();
  const endpointErrorCounts = new Map(); // endpoint -> total errors (all groups)
  const endpointErrorCountsByGroup = new Map(); // endpoint|group -> count
  const errorStatusCounts = { s0: 0, s503: 0, s4xx: 0, s5xxOther: 0 };
  const getBucket = (idx) => {
    if (!buckets.has(idx)) {
      buckets.set(idx, { count: 0, fails: 0, durations: [], s503: 0, s0: 0 });
    }
    return buckets.get(idx);
  };
  const rl = createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'Point') continue;
    const t = new Date(obj.data?.time).getTime();
    if (!Number.isFinite(t)) continue;
    if (startTime === null) startTime = t;
    const bucketIdx = Math.floor((t - startTime) / 30000);
    const bucket = getBucket(bucketIdx);
    if (obj.metric === 'http_req_failed') {
      bucket.count++;
      if (obj.data.value > 0) bucket.fails++;
    } else if (obj.metric === 'http_req_duration') {
      bucket.durations.push(obj.data.value);
    } else if (obj.metric === 'http_res_status_503_total') {
      bucket.s503++;
      errorStatusCounts.s503++;
    } else if (obj.metric === 'http_res_status_0_total') {
      bucket.s0++;
      errorStatusCounts.s0++;
    } else if (obj.metric === 'http_res_status_4xx_total') {
      errorStatusCounts.s4xx++;
    } else if (obj.metric === 'http_res_status_5xx_other_total') {
      errorStatusCounts.s5xxOther++;
    } else if (obj.metric === 'http_error_by_endpoint_total') {
      const endpoint = obj.data?.tags?.endpoint || 'unknown';
      const status = obj.data?.tags?.status || '';
      const statusClass = obj.data?.tags?.status_class || '';
      let group = 'other';
      if (status === '0' || statusClass === '0xx') group = 'timeouts';
      else if (status === '503') group = '503';
      else if (statusClass === '4xx') group = '4xx';
      else if (statusClass === '5xx') group = '5xx-other';

      endpointErrorCounts.set(endpoint, (endpointErrorCounts.get(endpoint) || 0) + 1);
      endpointErrorCountsByGroup.set(
        `${endpoint}|${group}`,
        (endpointErrorCountsByGroup.get(`${endpoint}|${group}`) || 0) + 1,
      );
    }
  }
  if (buckets.size === 0) return null;
  const maxBucket = Math.max(...buckets.keys());
  const rows = [];
  for (let i = 0; i <= maxBucket; i++) {
    const b = buckets.get(i) ?? { count: 0, fails: 0, durations: [], s503: 0, s0: 0 };
    const mins = Math.floor((i * 30) / 60);
    const secs = (i * 30) % 60;
    const elapsed = `${String(mins).padStart(2, '0')}m${String(secs).padStart(2, '0')}s`;
    const failRate = b.count > 0 ? (b.fails / b.count) * 100 : 0;
    const sorted = b.durations.sort((a, c) => a - c);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.50)] : null;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : null;
    rows.push({ elapsed, count: b.count, fails: b.fails, failRate, p50, p95, s503: b.s503, s0: b.s0 });
  }
  const endpointErrors = [...endpointErrorCounts.entries()]
    .map(([endpoint, count]) => ({ endpoint, count }))
    .sort((a, b) => b.count - a.count);
  const endpointGroupErrors = [...endpointErrorCountsByGroup.entries()]
    .map(([key, count]) => {
      const [endpoint, group] = key.split('|');
      return { endpoint, group, count };
    })
    .sort((a, b) => b.count - a.count);
  return { timeline: rows, endpointErrors, endpointGroupErrors, errorStatusCounts };
}

const summary = readJson(path.join(runDir, 'summary.json'));
const before = readJson(path.join(runDir, 'prometheus-before.json'));
const after = readJson(path.join(runDir, 'prometheus-after.json'));
const metadata = readMetadata(path.join(runDir, 'metadata.txt'));
const appErrorSummary = summarizeAppErrors(path.join(runDir, 'app-errors.log'));

const lines = [];
lines.push('# Staging capacity report');
lines.push('');
lines.push(`- Run directory: \`${runDir}\``);
lines.push(`- k6 exit code: \`${exitCode}\``);
lines.push(`- Outcome: ${exitCode === 0 ? 'thresholds held for the selected profile' : 'thresholds were breached or the system began failing under load'}`);
if (metadata) {
  lines.push(
    `- Profile: \`${metadata.profile || 'n/a'}\` / Git SHA: \`${metadata.git_sha || 'n/a'}\`${metadata.git_sha_full ? ` (full \`${metadata.git_sha_full}\`)` : ''}`,
  );
  lines.push(`- Base URL: \`${metadata.base_url || 'n/a'}\``);
  lines.push(
    `- Shed enabled: \`${metadata.overload_http_shed_enabled || 'n/a'}\` (lag ms: \`${metadata.overload_lag_shed_ms || 'n/a'}\`), pool queue: \`${metadata.pool_circuit_breaker_queue || 'n/a'}\``,
  );
}
lines.push('');
lines.push('## k6 summary');
lines.push('');
lines.push(`- Total requests: ${fmt(metric(summary, 'http_reqs', 'count'))}`);
const httpFailRate =
  metric(summary, 'http_req_failed', 'rate') ?? metric(summary, 'http_req_failed', 'value');
lines.push(
  `- HTTP status failure rate (k6 default; non-2xx/3xx): ${fmt((httpFailRate ?? 0) * 100, '%')}`,
);
lines.push(`- Overall p95 latency: ${fmt(metric(summary, 'http_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Overall p99 latency: ${fmt(metric(summary, 'http_req_duration', 'p(99)'), ' ms')}`);
lines.push(`- Communities p95: ${fmt(metric(summary, 'communities_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Conversations p95: ${fmt(metric(summary, 'conversations_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Channels p95: ${fmt(metric(summary, 'channels_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Message post p95: ${fmt(metric(summary, 'message_post_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Auth login p95: ${fmt(metric(summary, 'auth_login_req_duration', 'p(95)'), ' ms')}`);
lines.push(
  `- WebSocket success rate: ${fmt((metric(summary, 'ws_connect_success', 'rate') ?? metric(summary, 'ws_connect_success', 'value') ?? 0) * 100, '%')}`,
);
const dropped = metric(summary, 'dropped_iterations', 'count');
const iters = metric(summary, 'iterations', 'count');
if (typeof dropped === 'number' || typeof iters === 'number') {
  const dropPct = typeof dropped === 'number' && typeof iters === 'number' && iters + dropped > 0
    ? ((dropped / (iters + dropped)) * 100).toFixed(1)
    : null;
  lines.push(
    `- Iterations **completed**: ${fmt(iters)} — **dropped** (never started): ${fmt(dropped)}${dropPct !== null ? ` (${dropPct}% of planned iterations)` : ''} — if large, raise **preAllocatedVUs** / **maxVUs** so the arrival-rate executor can keep up`,
  );
  if (dropPct !== null && parseFloat(dropPct) >= 10) {
    const iterP95 = metric(summary, 'iteration_duration', 'p(95)');
    lines.push(
      `- **VU shortfall:** Planned arrival rate was not fully achieved — need roughly **\`maxVUs ≥ iter/s × iteration duration (s)\`** (e.g. p95 iteration ${iterP95 != null ? `${(iterP95 / 1000).toFixed(1)}s` : '…'} × peak stage target). Lower the peak stage \`target\` or raise \`maxVUs\` / runner memory.`,
    );
  }
}
lines.push(
  `- Iteration duration p95: ${fmt(metric(summary, 'iteration_duration', 'p(95)'), ' ms')} (full httpMix iteration incl. sleep)`,
);
lines.push('');
lines.push('## Optimization KPIs (k6 `optimization_*` counters)');
lines.push('');
lines.push('| KPI | Value | Source |');
lines.push('|-----|-------|--------|');
lines.push(
  `| **Peak rate** (HTTP) | ${fmt(metric(summary, 'http_reqs', 'rate'), ' req/s')} | \`http_reqs\` rate |`,
);
lines.push(
  `| **Peak VUs** (scheduler) | ${fmt(metric(summary, 'vus', 'max'))} | \`vus.max\` |`,
);
lines.push(
  `| **WS sessions** (completed) | ${fmt(metric(summary, 'ws_sessions', 'count'))} | \`ws_sessions.count\` |`,
);
const loginFail = metricCounter(summary, 'optimization_login_fail_total');
const postFail = metricCounter(summary, 'optimization_message_post_fail_total');
const wsFail = metricCounter(summary, 'optimization_ws_handshake_fail_total');
const outageCnt = metricCounter(summary, 'optimization_http_outage_total');
lines.push(
  `| **Login fails** | ${fmt(loginFail ?? 0)} | failed \`auth login 200\` check in \`httpMix\` |`,
);
lines.push(
  `| **Delivery fails** (message POST) | ${fmt(postFail ?? 0)} | failed 201 check on channel/DM post |`,
);
lines.push(
  `| **WS handshake fails** | ${fmt(wsFail ?? 0)} | no HTTP 101 on \`/ws\` |`,
);
lines.push(
  `| **HTTP outage signals** | ${fmt(outageCnt ?? 0)} | responses with status **0** or **≥500** |`,
);
lines.push('');
lines.push(
  '_**Peak connections** — target concurrent WS load is profile `wsVUs`; HTTP parallelism is capped by `maxVUs` in `load-tests/staging-capacity.js`. Compare `vus.max` and `ws_sessions` run-over-run._',
);
lines.push(
  '_Real-time message **fan-out** to other clients is not asserted in this script; extend WS scenarios to subscribe to a channel and await `message:created` if you need end-to-end delivery proof._',
);
lines.push('');
const breaches = collectThresholdBreaches(summary);
if (breaches.length) {
  lines.push('## k6 threshold breaches');
  lines.push('');
  lines.push(
    'Each row is a threshold that k6 marked as **violated** (`true` in `summary.json`).',
  );
  lines.push('');
  for (const b of breaches) {
    lines.push(`- \`${b.metric}\`: **${b.expr}**`);
  }
  lines.push('');
}
lines.push('### How to read this run');
lines.push('');
lines.push(
  '- **Exit code ≠ 0** with **0% HTTP status failures** usually means **p95/p99** or **per-route Trends** breached — not that the server returned no errors.',
);
lines.push(
  '- **Dropped iterations** mean k6 could not spawn work fast enough; the **real** offered load was lower than the scenario target until you add VU headroom.',
);
lines.push('');
lines.push('## HTTP response shape (k6 counters)');
lines.push('');
lines.push(
  'Counts **instrumented responses** (status 0 = timeout / no response; 503 = overload shed, pool circuit, or upstream; 4xx/5xx-other = remaining errors).',
);
const c0 = metricCounter(summary, 'http_res_status_0_total');
const c503 = metricCounter(summary, 'http_res_status_503_total');
const c4 = metricCounter(summary, 'http_res_status_4xx_total');
const c5 = metricCounter(summary, 'http_res_status_5xx_other_total');
lines.push(`- Status **0**: ${fmt(c0 ?? 0)}${counterAbsentNote(c0)}`);
lines.push(`- Status **503**: ${fmt(c503 ?? 0)}${counterAbsentNote(c503)}`);
lines.push(`- Status **4xx**: ${fmt(c4 ?? 0)}`);
lines.push(`- Status **5xx (not 503)**: ${fmt(c5 ?? 0)}`);
lines.push('');
lines.push('## Prometheus after-run snapshot');
lines.push('');

const promErrAfter = gatherPrometheusQueryErrors(after);
const promErrBefore = gatherPrometheusQueryErrors(before);
const promErrs = [...promErrBefore, ...promErrAfter].filter(
  (e, i, a) => a.findIndex((x) => x.name === e.name && x.error === e.error) === i,
);
if (promErrs.length) {
  lines.push('### Prometheus query errors');
  lines.push('');
  lines.push('Remote `query_range` / SSH / curl failed for these — values below may be **n/a**.');
  lines.push('');
  for (const e of promErrs.slice(0, 12)) {
    lines.push(`- **${e.name}**: ${e.error.slice(0, 220)}${e.error.length > 220 ? '…' : ''}`);
  }
  lines.push('');
}
lines.push(`- RSS memory: ${fmt(promScalar(after, 'rss_mb'), ' MB')}`);
lines.push(`- CPU utilisation (post-run ~2 m avg): ${fmt((promScalar(after, 'cpu_seconds_rate') ?? 0) * 100, '%')} — use peak below for accurate burst figure`);
lines.push(`- CPU peak during run (max 1 m rate over 12 m): ${fmt((promScalar(after, 'cpu_peak_rate') ?? 0) * 100, '%')}`);
const cpuByInstance = promResult(after, 'cpu_by_instance');
if (cpuByInstance.length > 1) {
  for (const item of cpuByInstance) {
    const inst = item.metric?.instance ?? 'unknown';
    const val = Number(item.value?.[1]);
    if (Number.isFinite(val)) lines.push(`  - ${inst}: ${fmt(val * 100, '%')}`);
  }
}
lines.push(`- Event loop p99 (post-run): ${fmt(promScalar(after, 'eventloop_p99_ms'), ' ms')}`);
lines.push(`- Event loop p99 peak: ${fmt(promScalar(after, 'eventloop_peak_ms'), ' ms')}`);
lines.push(`- 5xx rate (post-run instant): ${fmt(promScalar(after, 'five_xx_rate', 0), ' req/s')}`);
lines.push(`- 5xx rate peak during run: ${fmt(promScalar(after, 'five_xx_peak_rate', 0), ' req/s')}`);
const fiveXxInc = promScalar(after, 'five_xx_increase_15m', null);
const abortInc = promScalar(after, 'http_aborted_increase_15m', null);
if (fiveXxInc !== null) {
  lines.push(`- **5xx completed count (∆15m window)** — use when peak rate is 0 after cooldown: ${fmt(fiveXxInc)}`);
}
if (abortInc !== null) {
  lines.push(`- **HTTP aborted (∆15m)** (connection closed before response finished; correlates with k6 status 0): ${fmt(abortInc)}`);
}

const overloadShedAfter = promScalar(after, 'overload_shed_total', 0);
const overloadShedBefore = promScalar(before, 'overload_shed_total', 0);
const overloadShedDelta = (overloadShedAfter ?? 0) - (overloadShedBefore ?? 0);
lines.push(`- HTTP overload shed total (during run): ${fmt(overloadShedDelta)}`);
lines.push(`- Overload stage max (0–3, post-run instant): ${fmt(promScalar(after, 'overload_stage_max'))}`);
const pgTotal = promScalarPrefer(after, 'pg_pool_total', 'pg_pool_total_any');
const pgIdle = promScalarPrefer(after, 'pg_pool_idle', 'pg_pool_idle_any');
const pgWait = promScalarPrefer(after, 'pg_pool_waiting', 'pg_pool_waiting_any');
lines.push(
  `- PG pool peak-total / min-idle / peak-waiting: ${fmt(pgTotal)} / ${fmt(pgIdle)} / ${fmt(pgWait)}${promScalar(after, 'pg_pool_total') === null && pgTotal !== null ? ' _(fallback: query without job label)_' : ''}`,
);
const redisMb = promScalar(after, 'redis_memory_mb');
const redisClients = promScalar(after, 'redis_connected_clients');
lines.push(`- Redis memory: ${fmt(redisMb, ' MB')} / connected clients: ${fmt(redisClients)}`);
if (redisMb === null && redisClients === null) {
  const redisErr = promErrs.some((e) => e.name.includes('redis'));
  lines.push(
    redisErr
      ? '  - *Redis query failed (see Prometheus query errors above) or no redis_exporter series.*'
      : '  - *No Redis exporter series in Prometheus for this scrape (add redis_exporter target or check job labels).*',
  );
}

const topFiveXxRoutes = promResult(after, 'five_xx_by_route_peak')
  .map((item) => ({ route: item.metric?.route || 'unknown', value: Number(item.value?.[1]) }))
  .filter((item) => Number.isFinite(item.value) && item.value > 0);
if (topFiveXxRoutes.length) {
  lines.push('### Top 5xx routes during run (peak req/s)');
  for (const item of topFiveXxRoutes.slice(0, 8)) {
    lines.push(`- ${item.route}: ${fmt(item.value, ' req/s')}`);
  }
  lines.push('');
}

const topFiveXxIncreaseRoutes = promResult(after, 'five_xx_increase_by_route_15m')
  .map((item) => ({ route: item.metric?.route || 'unknown', value: Number(item.value?.[1]) }))
  .filter((item) => Number.isFinite(item.value) && item.value > 0);
if (topFiveXxIncreaseRoutes.length) {
  lines.push('### Top 5xx routes (∆15m completed count)');
  for (const item of topFiveXxIncreaseRoutes.slice(0, 8)) {
    lines.push(`- ${item.route}: ${fmt(item.value)}`);
  }
  lines.push('');
}

const topAbortedRoutes = promResult(after, 'http_aborted_increase_by_route_15m')
  .map((item) => ({ route: item.metric?.route || 'unknown', value: Number(item.value?.[1]) }))
  .filter((item) => Number.isFinite(item.value) && item.value > 0);
if (topAbortedRoutes.length) {
  lines.push('### Top aborted routes (∆15m)');
  for (const item of topAbortedRoutes.slice(0, 8)) {
    lines.push(`- ${item.route}: ${fmt(item.value)}`);
  }
  lines.push('');
}

if (appErrorSummary && appErrorSummary.total > 0) {
  lines.push('### Backend error signatures during run (journalctl)');
  lines.push(`- Matched error lines: ${fmt(appErrorSummary.total)}`);
  for (const item of appErrorSummary.signatures.slice(0, 8)) {
    lines.push(`- ${fmt(item.count)}x ${item.signature}`);
  }
  lines.push('');
}

const queueDepth = promResult(after, 'side_effect_queue_depth');
if (queueDepth.length) {
  lines.push('### Side-effect queue depth');
  for (const item of queueDepth) {
    lines.push(`- ${item.metric?.queue || 'unknown'}: ${item.value?.[1] ?? 'n/a'}`);
  }
  lines.push('');
}

const routeP95 = promResult(after, 'route_p95_top')
  .map((item) => ({ ...item, numericValue: Number(item.value?.[1]) }))
  .filter((item) => Number.isFinite(item.numericValue));
if (routeP95.length) {
  lines.push('### Top p95 routes after the run');
  for (const item of routeP95.slice(0, 8)) {
    lines.push(`- ${item.metric?.route || 'unknown'}: ${fmt(item.numericValue, ' ms')}`);
  }
  lines.push('');
}

const ndjsonAnalysis = await analyzeNdjson(path.join(runDir, 'metrics.ndjson'));
if (ndjsonAnalysis?.endpointErrors?.length) {
  lines.push('## Top failing endpoints (k6)');
  lines.push('');
  for (const item of ndjsonAnalysis.endpointErrors.slice(0, 8)) {
    lines.push(`- ${item.endpoint}: ${fmt(item.count)} errors`);
  }
  lines.push('');
}

if (ndjsonAnalysis?.endpointGroupErrors?.length) {
  const byGroup = (group) => ndjsonAnalysis.endpointGroupErrors
    .filter((x) => x.group === group)
    .slice(0, 6)
    .map((x) => `${x.endpoint}: ${fmt(x.count)} errors`);

  const timeoutsTop = byGroup('timeouts');
  if (timeoutsTop.length) {
    lines.push('## Top timeout/no-response endpoints (k6 status 0)');
    lines.push('');
    for (const line of timeoutsTop) lines.push(`- ${line}`);
    lines.push('');
  }

  const fiveXxTop = byGroup('5xx-other');
  if (fiveXxTop.length) {
    lines.push('## Top internal 5xx endpoints (k6 status 5xx-other)');
    lines.push('');
    for (const line of fiveXxTop) lines.push(`- ${line}`);
    lines.push('');
  }
}

if (ndjsonAnalysis?.errorStatusCounts) {
  const breakdown = ndjsonAnalysis.errorStatusCounts;
  const totalErrors = breakdown.s0 + breakdown.s503 + breakdown.s4xx + breakdown.s5xxOther;
  if (totalErrors > 0) {
    const pct = (n) => `${((n / totalErrors) * 100).toFixed(1)}%`;
    lines.push('## Error composition (k6)');
    lines.push('');
    lines.push(`- Status 0 (timeout / no response): ${fmt(breakdown.s0)} (${pct(breakdown.s0)})`);
    lines.push(`- Status 503: ${fmt(breakdown.s503)} (${pct(breakdown.s503)})`);
    lines.push(`- Status 4xx: ${fmt(breakdown.s4xx)} (${pct(breakdown.s4xx)})`);
    lines.push(`- Status 5xx (not 503): ${fmt(breakdown.s5xxOther)} (${pct(breakdown.s5xxOther)})`);
    lines.push('');
  }
}

const timeline = ndjsonAnalysis?.timeline;
if (timeline && timeline.length > 0) {
  lines.push('## Request timeline (30 s buckets)');
  lines.push('');
  lines.push('| elapsed | reqs | fails | fail% | p50 ms | p95 ms | 503 | 0 |');
  lines.push('|---------|------|-------|-------|--------|--------|-----|---|');
  for (const row of timeline) {
    const mark = row.failRate >= 5 ? ' ⚠' : '';
    lines.push(
      `| ${row.elapsed} | ${row.count} | ${row.fails} | ${row.failRate.toFixed(1)}%${mark} | ${fmt(row.p50)} | ${fmt(row.p95)} | ${fmt(row.s503)} | ${fmt(row.s0)} |`,
    );
  }
  lines.push('');
}

if (before || after) {
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- `summary.json` — aggregate k6 metrics');
  lines.push('- `metrics.ndjson` — raw request timeline');
  lines.push('- `prometheus-before.json` — baseline staging metrics');
  lines.push('- `prometheus-after.json` — post-run staging metrics');
}

console.log(lines.join('\n'));
