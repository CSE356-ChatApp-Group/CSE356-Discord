#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [baselineDir, candidateDir] = process.argv.slice(2);

if (!baselineDir || !candidateDir) {
  console.error('Usage: node scripts/load/compare-capacity-runs.mjs <baseline-run-dir> <candidate-run-dir>');
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readMetadata(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    const entries = lines
      .map((line) => {
        const i = line.indexOf('=');
        if (i < 1) return null;
        return [line.slice(0, i), line.slice(i + 1)];
      })
      .filter(Boolean);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function metric(summary, name, stat) {
  const entry = summary?.metrics?.[name];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.values && Object.prototype.hasOwnProperty.call(entry.values, stat)) return entry.values[stat];
  if (Object.prototype.hasOwnProperty.call(entry, stat)) return entry[stat];
  return null;
}

function promScalar(snapshot, key) {
  const result = snapshot?.queries?.[key]?.data?.result;
  if (!Array.isArray(result) || !result.length) return null;
  const parsed = Number(result[0]?.value?.[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function n(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (typeof value !== 'number') return String(value);
  return value.toFixed(digits);
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function delta(base, cand, opts = { inverseBetter: false, asPercent: false }) {
  if (base === null || base === undefined || cand === null || cand === undefined) return 'n/a';
  const d = cand - base;
  const sign = d > 0 ? '+' : '';
  if (opts.asPercent) return `${sign}${(d * 100).toFixed(2)}pp`;
  const val = `${sign}${d.toFixed(2)}`;
  if (!opts.inverseBetter) return val;
  return d <= 0 ? `${val} (better)` : `${val} (worse)`;
}

function loadRun(runDir) {
  const summary = readJson(path.join(runDir, 'summary.json'));
  const after = readJson(path.join(runDir, 'prometheus-after.json'));
  const metadata = readMetadata(path.join(runDir, 'metadata.txt'));
  return { runDir, summary, after, metadata };
}

function extract(run) {
  const { summary, after } = run;
  const failRate = metric(summary, 'http_req_failed', 'rate') ?? metric(summary, 'http_req_failed', 'value');
  const dropped = metric(summary, 'dropped_iterations', 'count');
  const completed = metric(summary, 'iterations', 'count');
  return {
    profile: run.metadata.profile || 'n/a',
    gitSha: run.metadata.git_sha || 'n/a',
    totalRequests: metric(summary, 'http_reqs', 'count'),
    failRate,
    p95: metric(summary, 'http_req_duration', 'p(95)'),
    p99: metric(summary, 'http_req_duration', 'p(99)'),
    throughput: metric(summary, 'http_reqs', 'rate'),
    dropped,
    completed,
    wsSuccess: metric(summary, 'ws_connect_success', 'rate') ?? metric(summary, 'ws_connect_success', 'value'),
    msgPostP95: metric(summary, 'message_post_req_duration', 'p(95)'),
    communitiesP95: metric(summary, 'communities_req_duration', 'p(95)'),
    channelsP95: metric(summary, 'channels_req_duration', 'p(95)'),
    conversationsP95: metric(summary, 'conversations_req_duration', 'p(95)'),
    loginP95: metric(summary, 'auth_login_req_duration', 'p(95)'),
    wsDeliveryP95: metric(summary, 'message_ws_delivery_after_post_ms', 'p(95)'),
    wsDeliveryMisses: metric(summary, 'optimization_ws_message_delivery_miss_total', 'count'),
    s0: metric(summary, 'http_res_status_0_total', 'count'),
    s503: metric(summary, 'http_res_status_503_total', 'count'),
    s5xxOther: metric(summary, 'http_res_status_5xx_other_total', 'count'),
    poolWaitingPeak: promScalar(after, 'pg_pool_waiting') ?? promScalar(after, 'pg_pool_waiting_any'),
    poolTotalPeak: promScalar(after, 'pg_pool_total') ?? promScalar(after, 'pg_pool_total_any'),
    fiveXxPeakRate: promScalar(after, 'five_xx_peak_rate'),
    fiveXxIncrease15m: promScalar(after, 'five_xx_increase_15m'),
    abortedIncrease15m: promScalar(after, 'http_aborted_increase_15m'),
    eventLoopPeakMs: promScalar(after, 'eventloop_peak_ms'),
    authBcryptActivePeak: promScalar(after, 'auth_bcrypt_active_peak'),
    authBcryptWaitersPeak: promScalar(after, 'auth_bcrypt_waiters_peak'),
    cpuPeakRate: promScalar(after, 'cpu_peak_rate'),
  };
}

function renderMetricRow(name, b, c, options = {}) {
  const baseline = options.format ? options.format(b) : n(b);
  const candidate = options.format ? options.format(c) : n(c);
  return `| ${name} | ${baseline} | ${candidate} | ${delta(b, c, options.delta)} |`;
}

const baseRun = loadRun(baselineDir);
const candRun = loadRun(candidateDir);
const b = extract(baseRun);
const c = extract(candRun);

const lines = [];
lines.push('# Capacity Run Comparison');
lines.push('');
lines.push(`- Baseline: \`${baselineDir}\` (\`${b.profile}\`, sha \`${b.gitSha}\`)`);
lines.push(`- Candidate: \`${candidateDir}\` (\`${c.profile}\`, sha \`${c.gitSha}\`)`);
lines.push('');
lines.push('| Metric | Baseline | Candidate | Delta (candidate-baseline) |');
lines.push('|---|---:|---:|---:|');
lines.push(renderMetricRow('HTTP req/s (avg)', b.throughput, c.throughput, { format: (x) => n(x), delta: { inverseBetter: false } }));
lines.push(renderMetricRow('HTTP failed rate', b.failRate, c.failRate, { format: pct, delta: { inverseBetter: true, asPercent: true } }));
lines.push(renderMetricRow('HTTP p95 (ms)', b.p95, c.p95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('HTTP p99 (ms)', b.p99, c.p99, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Dropped iterations', b.dropped, c.dropped, { format: (x) => n(x, 0), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Completed iterations', b.completed, c.completed, { format: (x) => n(x, 0), delta: { inverseBetter: false } }));
lines.push(renderMetricRow('WS success rate', b.wsSuccess, c.wsSuccess, { format: pct, delta: { inverseBetter: false, asPercent: true } }));
lines.push(renderMetricRow('Messages POST p95 (ms)', b.msgPostP95, c.msgPostP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Communities p95 (ms)', b.communitiesP95, c.communitiesP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Channels p95 (ms)', b.channelsP95, c.channelsP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Conversations p95 (ms)', b.conversationsP95, c.conversationsP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Auth login p95 (ms)', b.loginP95, c.loginP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('WS delivery p95 (ms)', b.wsDeliveryP95, c.wsDeliveryP95, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('WS delivery misses', b.wsDeliveryMisses, c.wsDeliveryMisses, { format: (x) => n(x, 0), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Status 0 count', b.s0, c.s0, { format: (x) => n(x, 0), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Status 503 count', b.s503, c.s503, { format: (x) => n(x, 0), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Status 5xx-other count', b.s5xxOther, c.s5xxOther, { format: (x) => n(x, 0), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('PG pool waiting peak', b.poolWaitingPeak, c.poolWaitingPeak, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('PG pool total peak', b.poolTotalPeak, c.poolTotalPeak, { format: (x) => n(x), delta: { inverseBetter: false } }));
lines.push(renderMetricRow('5xx peak rate', b.fiveXxPeakRate, c.fiveXxPeakRate, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('5xx increase (15m)', b.fiveXxIncrease15m, c.fiveXxIncrease15m, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('HTTP aborted increase (15m)', b.abortedIncrease15m, c.abortedIncrease15m, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Event loop peak (ms)', b.eventLoopPeakMs, c.eventLoopPeakMs, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Auth bcrypt active peak', b.authBcryptActivePeak, c.authBcryptActivePeak, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('Auth bcrypt waiters peak', b.authBcryptWaitersPeak, c.authBcryptWaitersPeak, { format: (x) => n(x), delta: { inverseBetter: true } }));
lines.push(renderMetricRow('CPU peak rate (cores)', b.cpuPeakRate, c.cpuPeakRate, { format: (x) => n(x), delta: { inverseBetter: false } }));
lines.push('');
lines.push('## Notes');
lines.push('- Lower is better for latency, failures, status 0/503/5xx counts, pool waiting, and abort deltas.');
lines.push('- Higher is better for completed throughput and WS success rate.');
lines.push('- Keep profile type comparable when evaluating tuning (e.g., break vs break, slo vs slo).');

console.log(lines.join('\n'));
