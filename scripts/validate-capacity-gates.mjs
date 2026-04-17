#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const runDir = process.argv[2];
const profile = process.argv[3] || '';

if (!runDir) {
  console.error('Usage: node scripts/validate-capacity-gates.mjs <run-dir> [profile]');
  process.exit(1);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
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
  const n = Number(result[0]?.value?.[1]);
  return Number.isFinite(n) ? n : null;
}

const summary = readJson(path.join(runDir, 'summary.json'));
const after = readJson(path.join(runDir, 'prometheus-after.json'));
const appLog = path.join(runDir, 'app.log');
const errors = [];

if (!summary) {
  errors.push('missing summary.json');
} else {
  const failRate = metric(summary, 'http_req_failed', 'rate') ?? metric(summary, 'http_req_failed', 'value') ?? 1;
  const p95 = metric(summary, 'http_req_duration', 'p(95)');
  const p99 = metric(summary, 'http_req_duration', 'p(99)');
  if (failRate > Number(process.env.SLO_GATE_MAX_FAIL_RATE || 0.01)) {
    errors.push(`http_req_failed rate too high: ${failRate}`);
  }
  if (Number.isFinite(p95) && p95 > Number(process.env.SLO_GATE_MAX_P95_MS || 1500)) {
    errors.push(`p95 too high: ${p95}ms`);
  }
  if (Number.isFinite(p99) && p99 > Number(process.env.SLO_GATE_MAX_P99_MS || 3000)) {
    errors.push(`p99 too high: ${p99}ms`);
  }

  // Mirror k6 SLO thresholds on WS post→delivery probes (only when exported in this run).
  const missLimit = Number(process.env.SLO_GATE_WS_DELIVERY_MISS_LIMIT ?? 5);
  for (const name of [
    'optimization_ws_message_delivery_miss_total',
    'optimization_ws_userfeed_delivery_miss_total',
  ]) {
    if (!summary.metrics || !Object.prototype.hasOwnProperty.call(summary.metrics, name)) continue;
    const c = metric(summary, name, 'count');
    if (c == null || !Number.isFinite(c)) continue;
    if (c >= missLimit) {
      errors.push(`${name} too high: ${c} (require count < ${missLimit}, same as k6 slo profile)`);
    }
  }
}

if (after) {
  const pgWait = promScalar(after, 'pg_pool_waiting') ?? promScalar(after, 'pg_pool_waiting_any');
  if (Number.isFinite(pgWait) && pgWait > Number(process.env.SLO_GATE_MAX_PG_WAITING || 10)) {
    errors.push(`pg_pool_waiting sustained too high: ${pgWait}`);
  }
}

if (fs.existsSync(appLog)) {
  const raw = fs.readFileSync(appLog, 'utf8');
  if (/no live upstreams/i.test(raw) || /connection refused/i.test(raw)) {
    errors.push('detected upstream outage signatures in app.log');
  }
}

if (errors.length) {
  console.error(`Capacity gates failed (${profile || 'profile'}):`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log(`Capacity gates passed (${profile || 'profile'}).`);
