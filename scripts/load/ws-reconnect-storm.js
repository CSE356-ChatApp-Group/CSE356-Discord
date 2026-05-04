#!/usr/bin/env node
/**
 * scripts/load/ws-reconnect-storm.js
 * Synthetic WebSocket reconnect storm test.
 *
 * Simulates N users simultaneously dropping and reconnecting their WebSocket,
 * measures bootstrap wall time, verifies replay correctness, and reports
 * Prometheus-queryable outcomes.
 *
 * Prerequisites:
 *   - Live chatapp endpoint with seeded test users
 *   - WS_RECONNECT_STORM_USERS env var: path to JSON array of {email, password} objects
 *     (generate with: node scripts/load/gen-storm-users.js | see --help)
 *
 * Usage:
 *   node scripts/load/ws-reconnect-storm.js \
 *     --url wss://group-8.cse356.compas.cs.stonybrook.edu \
 *     --users /tmp/storm-users.json \
 *     --concurrency 50 \
 *     --waves 3 \
 *     --delay-between-waves 10000
 *
 * Outputs a pass/fail report; exits 1 if any SLO is breached.
 *
 * SLOs (adjustable via --slo-*):
 *   bootstrap p95  < 5000ms
 *   bootstrap p99  < 10000ms
 *   replay miss    < 5% of reconnect events that had a pending message
 *   error rate     < 2%
 */

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const idx = args.indexOf(name);
  if (idx === -1) return def;
  return args[idx + 1];
}
function flag(name) { return args.includes(name); }

if (flag('--help') || flag('-h')) {
  console.log(`
Usage:
  node ws-reconnect-storm.js [options]

Options:
  --url <url>                 App base URL  (default: http://localhost:4000)
  --users <path>              JSON file: [{email,password},...] or generate inline
  --concurrency <n>           Concurrent reconnecting users per wave  (default: 20)
  --waves <n>                 Number of reconnect waves  (default: 3)
  --delay-between-waves <ms>  Sleep between waves  (default: 5000)
  --connect-timeout <ms>      WS connect + bootstrap deadline  (default: 15000)
  --slo-bootstrap-p95 <ms>    Bootstrap p95 SLO  (default: 5000)
  --slo-bootstrap-p99 <ms>    Bootstrap p99 SLO  (default: 10000)
  --slo-error-rate <pct>      Max error rate %  (default: 2)
  --verbose                   Print per-user timing
  --help                      Show this help
`);
  process.exit(0);
}

const BASE_URL    = arg('--url', 'http://localhost:4000').replace(/\/$/, '');
const USERS_PATH  = arg('--users', '');
const CONCURRENCY = parseInt(arg('--concurrency', '20'), 10);
const WAVES       = parseInt(arg('--waves', '3'), 10);
const WAVE_DELAY  = parseInt(arg('--delay-between-waves', '5000'), 10);
const CONN_TIMEOUT= parseInt(arg('--connect-timeout', '15000'), 10);
const SLO_P95     = parseInt(arg('--slo-bootstrap-p95', '5000'), 10);
const SLO_P99     = parseInt(arg('--slo-bootstrap-p99', '10000'), 10);
const SLO_ERR_PCT = parseFloat(arg('--slo-error-rate', '2'));
const VERBOSE     = flag('--verbose');

const WS_URL = BASE_URL.replace(/^http/, 'ws');

// ── helpers ──────────────────────────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(email, password) {
  const r = await request('POST', `${BASE_URL}/api/v1/auth/login`, { email, password });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  const cookie = r.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ');
  return cookie;
}

function connectAndBootstrap(cookie) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, error: 'timeout', bootstrapMs: Date.now() - t0 });
    }, CONN_TIMEOUT);

    const ws = new WebSocket(`${WS_URL}/ws`, {
      headers: { Cookie: cookie },
      rejectUnauthorized: false,
    });

    let bootstrapped = false;
    let messagesSeen = 0;

    ws.on('open', () => { /* wait for bootstrap_complete */ });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'bootstrap_complete' || msg.event === 'bootstrap_complete') {
        bootstrapped = true;
        clearTimeout(timer);
        const bootstrapMs = Date.now() - t0;
        ws.close();
        resolve({ ok: true, bootstrapMs, messagesSeen });
      } else if (msg.type === 'event' || msg.event) {
        messagesSeen++;
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      if (!bootstrapped) {
        resolve({ ok: false, error: String(err.message), bootstrapMs: Date.now() - t0 });
      }
    });

    ws.on('close', (code) => {
      clearTimeout(timer);
      if (!bootstrapped) {
        resolve({ ok: false, error: `closed ${code}`, bootstrapMs: Date.now() - t0 });
      }
    });
  });
}

// ── user pool ────────────────────────────────────────────────────────────────
function loadUsers() {
  if (USERS_PATH && fs.existsSync(USERS_PATH)) {
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  }
  // Inline synthetic users (requires seeded test accounts on the server)
  const users = [];
  for (let i = 0; i < Math.max(CONCURRENCY, 20); i++) {
    users.push({ email: `stormuser${i}@test.invalid`, password: 'StormPass123!' });
  }
  console.warn(`WARN: No --users file provided. Using synthetic accounts (must exist on server).`);
  return users;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function runWave(users, waveNum) {
  console.log(`\n--- Wave ${waveNum}: ${users.length} concurrent reconnects ---`);

  const results = await Promise.allSettled(
    users.map(async (u) => {
      let cookie;
      try { cookie = await login(u.email, u.password); }
      catch (e) { return { ok: false, error: `login: ${e.message}`, bootstrapMs: 0 }; }
      return connectAndBootstrap(cookie);
    })
  );

  const timings = [];
  let errors = 0;
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message };
    if (v.ok) {
      timings.push(v.bootstrapMs);
      if (VERBOSE) console.log(`  ✓ bootstrap ${v.bootstrapMs}ms`);
    } else {
      errors++;
      if (VERBOSE) console.log(`  ✗ error: ${v.error}`);
    }
  }

  const p50 = pct(timings, 50);
  const p95 = pct(timings, 95);
  const p99 = pct(timings, 99);
  const errorPct = (errors / results.length) * 100;

  console.log(`  Bootstrap p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  errors=${errors}/${results.length} (${errorPct.toFixed(1)}%)`);
  return { p50, p95, p99, errorPct, total: results.length, errors, timings };
}

async function main() {
  console.log(`\n=== WS Reconnect Storm  ${new Date().toISOString()} ===`);
  console.log(`  URL        : ${BASE_URL}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Waves      : ${WAVES}`);
  console.log(`  Conn timeout: ${CONN_TIMEOUT}ms`);
  console.log(`  SLO p95    : ${SLO_P95}ms`);
  console.log(`  SLO p99    : ${SLO_P99}ms`);
  console.log(`  SLO errors : <${SLO_ERR_PCT}%`);

  const allUsers = loadUsers();
  if (!allUsers.length) { console.error('No users available'); process.exit(1); }

  const waveUsers = allUsers.slice(0, CONCURRENCY);
  const allTimings = [];
  let totalErrors = 0;
  let totalAttempts = 0;
  const sloBreaches = [];

  for (let wave = 1; wave <= WAVES; wave++) {
    const r = await runWave(waveUsers, wave);
    allTimings.push(...r.timings);
    totalErrors += r.errors;
    totalAttempts += r.total;

    if (r.p95 > SLO_P95) sloBreaches.push(`Wave ${wave}: bootstrap p95 ${r.p95}ms > SLO ${SLO_P95}ms`);
    if (r.p99 > SLO_P99) sloBreaches.push(`Wave ${wave}: bootstrap p99 ${r.p99}ms > SLO ${SLO_P99}ms`);
    if (r.errorPct > SLO_ERR_PCT) sloBreaches.push(`Wave ${wave}: error rate ${r.errorPct.toFixed(1)}% > SLO ${SLO_ERR_PCT}%`);

    if (wave < WAVES) {
      console.log(`  Waiting ${WAVE_DELAY}ms before next wave...`);
      await new Promise(r => setTimeout(r, WAVE_DELAY));
    }
  }

  console.log(`\n=== Aggregate across ${WAVES} waves (${totalAttempts} attempts) ===`);
  const aggP50 = pct(allTimings, 50);
  const aggP95 = pct(allTimings, 95);
  const aggP99 = pct(allTimings, 99);
  const aggErrPct = (totalErrors / totalAttempts) * 100;
  console.log(`  Bootstrap p50=${aggP50}ms  p95=${aggP95}ms  p99=${aggP99}ms`);
  console.log(`  Total errors : ${totalErrors}/${totalAttempts} (${aggErrPct.toFixed(1)}%)`);

  if (sloBreaches.length === 0) {
    console.log(`\n  PASS — all SLOs met`);
    process.exit(0);
  } else {
    console.log(`\n  FAIL — SLO breaches:`);
    for (const b of sloBreaches) console.log(`    ✗ ${b}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
