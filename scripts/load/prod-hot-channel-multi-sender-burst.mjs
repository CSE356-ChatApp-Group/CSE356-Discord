#!/usr/bin/env node
/**
 * Prod hot-channel burst: N registered users (each joined to community) POST concurrently
 * for wall-clock duration. Same pattern as bench-channel-hot-sustained but one worker token each.
 *
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   BASE_URL=https://130.245.136.44/api/v1 \
 *   COMMUNITY_ID=... \
 *   CHANNEL_ID=... \
 *   OWNER_TOKEN=... \
 *   SENDERS=8 \
 *   DURATION_SEC=55 \
 *   node scripts/load/prod-hot-channel-multi-sender-burst.mjs
 */
const base = (process.env.BASE_URL || '').replace(/\/$/, '');
const communityId = process.env.COMMUNITY_ID || '';
const channelId = process.env.CHANNEL_ID || '';
const ownerToken = process.env.OWNER_TOKEN || '';
const senders = Math.min(32, Math.max(2, Number.parseInt(process.env.SENDERS || '8', 10)));
const durationSec = Math.min(300, Math.max(10, Number.parseInt(process.env.DURATION_SEC || '50', 10)));
const pw = process.env.SEED_PASSWORD || 'Password1!';

if (!base || !communityId || !channelId || !ownerToken) {
  console.error('Set BASE_URL, COMMUNITY_ID, CHANNEL_ID, OWNER_TOKEN');
  process.exit(1);
}

async function j(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}`);
    err.body = data;
    throw err;
  }
  return data;
}

async function registerJoin() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const username = `snd${stamp}`.slice(0, 32);
  const email = `snd-${stamp}@example.com`;
  const reg = await j('POST', '/auth/register', {
    email,
    username,
    password: pw,
    displayName: username,
  });
  const token = reg.accessToken;
  await j('POST', '/communities/join', { communityId }, token);
  return token;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

async function senderWorker(token, runUntilMs, out) {
  const url = `${base}/messages`;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;
  const latencies = [];
  const statusCounts = Object.create(null);
  while (Date.now() < runUntilMs) {
    seq += 1;
    const body = JSON.stringify({
      channelId,
      content: `multi-${runId}-${seq}-${Math.random().toString(36).slice(2, 10)}`,
    });
    const t0 = performance.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `multi-${runId}-${seq}`,
      },
      body,
    });
    const ms = performance.now() - t0;
    latencies.push(ms);
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
  }
  out.push({ latencies, statusCounts });
}

async function main() {
  const tokens = [ownerToken];
  console.error(`Registering ${senders - 1} joiners...`);
  for (let i = 1; i < senders; i += 1) {
    tokens.push(await registerJoin());
  }
  const wallStart = Date.now();
  const runUntilMs = wallStart + durationSec * 1000;
  const buckets = [];
  await Promise.all(tokens.map((t) => senderWorker(t, runUntilMs, buckets)));
  const wallMs = Date.now() - wallStart;

  const allMs = [];
  const statusCounts = Object.create(null);
  for (const b of buckets) {
    allMs.push(...b.latencies);
    for (const [k, v] of Object.entries(b.statusCounts)) {
      statusCounts[k] = (statusCounts[k] || 0) + v;
    }
  }
  allMs.sort((a, b) => a - b);
  const n = allMs.length;
  const ok = statusCounts[201] || 0;
  const s503 = statusCounts[503] || 0;

  console.log(
    JSON.stringify(
      {
        wall_duration_ms: wallMs,
        senders,
        duration_sec_target: durationSec,
        total_requests: n,
        ok_201: ok,
        status_503: s503,
        status_histogram: statusCounts,
        client_latency_ms: {
          p50: Math.round(percentile(allMs, 50) * 10) / 10,
          p95: Math.round(percentile(allMs, 95) * 10) / 10,
          p99: Math.round(percentile(allMs, 99) * 10) / 10,
        },
        throughput_201_per_sec: Math.round((ok / (wallMs / 1000)) * 100) / 100,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e.message, e.body || '');
  process.exit(1);
});
