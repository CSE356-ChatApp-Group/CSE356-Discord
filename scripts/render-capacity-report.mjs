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

// Stream metrics.ndjson and bucket http_req_failed + http_req_duration into
// 30 s windows. Each request emits exactly one Point for each metric, so counts
// stay in sync. Streaming avoids loading the full 200+ MB file into memory.
async function buildTimeline(ndjsonPath) {
  if (!fs.existsSync(ndjsonPath)) return null;
  let startTime = null;
  const buckets = new Map();
  const getBucket = (idx) => {
    if (!buckets.has(idx)) buckets.set(idx, { count: 0, fails: 0, durations: [] });
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
    }
  }
  if (buckets.size === 0) return null;
  const maxBucket = Math.max(...buckets.keys());
  const rows = [];
  for (let i = 0; i <= maxBucket; i++) {
    const b = buckets.get(i) ?? { count: 0, fails: 0, durations: [] };
    const mins = Math.floor((i * 30) / 60);
    const secs = (i * 30) % 60;
    const elapsed = `${String(mins).padStart(2, '0')}m${String(secs).padStart(2, '0')}s`;
    const failRate = b.count > 0 ? (b.fails / b.count) * 100 : 0;
    const sorted = b.durations.sort((a, c) => a - c);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.50)] : null;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : null;
    rows.push({ elapsed, count: b.count, fails: b.fails, failRate, p50, p95 });
  }
  return rows;
}

const summary = readJson(path.join(runDir, 'summary.json'));
const before = readJson(path.join(runDir, 'prometheus-before.json'));
const after = readJson(path.join(runDir, 'prometheus-after.json'));

const lines = [];
lines.push('# Staging capacity report');
lines.push('');
lines.push(`- Run directory: \`${runDir}\``);
lines.push(`- k6 exit code: \`${exitCode}\``);
lines.push(`- Outcome: ${exitCode === 0 ? 'thresholds held for the selected profile' : 'thresholds were breached or the system began failing under load'}`);
lines.push('');
lines.push('## k6 summary');
lines.push('');
lines.push(`- Total requests: ${fmt(metric(summary, 'http_reqs', 'count'))}`);
lines.push(`- Request failure rate: ${fmt((metric(summary, 'http_req_failed', 'rate') ?? metric(summary, 'http_req_failed', 'value') ?? 0) * 100, '%')}`);
lines.push(`- Overall p95 latency: ${fmt(metric(summary, 'http_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Overall p99 latency: ${fmt(metric(summary, 'http_req_duration', 'p(99)'), ' ms')}`);
lines.push(`- Communities p95: ${fmt(metric(summary, 'communities_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Conversations p95: ${fmt(metric(summary, 'conversations_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Message post p95: ${fmt(metric(summary, 'message_post_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- Auth login p95: ${fmt(metric(summary, 'auth_login_req_duration', 'p(95)'), ' ms')}`);
lines.push(`- WebSocket success rate: ${fmt((metric(summary, 'ws_connect_success', 'rate') ?? metric(summary, 'ws_connect_success', 'value') ?? 0) * 100, '%')}`);
lines.push('');
lines.push('## Prometheus after-run snapshot');
lines.push('');
lines.push(`- RSS memory: ${fmt(promScalar(after, 'rss_mb'), ' MB')}`);
lines.push(`- Event loop p99: ${fmt(promScalar(after, 'eventloop_p99_ms'), ' ms')}`);
lines.push(`- 5xx rate: ${fmt(promScalar(after, 'five_xx_rate', 0), ' req/s')}`);
lines.push(`- PG pool peak-total/min-idle/peak-waiting: ${fmt(promScalar(after, 'pg_pool_total'))} / ${fmt(promScalar(after, 'pg_pool_idle'))} / ${fmt(promScalar(after, 'pg_pool_waiting'))}`);

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

const timeline = await buildTimeline(path.join(runDir, 'metrics.ndjson'));
if (timeline && timeline.length > 0) {
  lines.push('## Request timeline (30 s buckets)');
  lines.push('');
  lines.push('| elapsed | reqs | fails | fail% | p50 ms | p95 ms |');
  lines.push('|---------|------|-------|-------|--------|--------|');
  for (const row of timeline) {
    const mark = row.failRate >= 5 ? ' ⚠' : '';
    lines.push(
      `| ${row.elapsed} | ${row.count} | ${row.fails} | ${row.failRate.toFixed(1)}%${mark} | ${fmt(row.p50)} | ${fmt(row.p95)} |`,
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
